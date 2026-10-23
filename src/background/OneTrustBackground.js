/* global OneTrustProvider */

/**
 * OneTrust background handling.
 *
 * OneTrustProvider only parses; everything here needs extension APIs or state
 * that outlives a single request: fetching response bodies, per-tab dedup,
 * reading the OptanonConsent cookie. Concatenated into serviceWorker-full.js
 * (see Gruntfile.js) between providers.js and serviceWorker.js.
 *
 * serviceWorker.js calls:
 *   OneTrustBackground.init(tabs)                              once, at top level
 *   OneTrustBackground.handleProviderData(data, pd, tabId)     per matched request
 *   OneTrustBackground.onNavigation(tabId, url)                per top-level commit
 */
const OneTrustBackground = (() => {
    /*
     * Per-tab OneTrust state.
     *
     * configFetched     — prevents duplicate "OneTrust Configuration" panel entries
     *                     (OneTrust loads the config JSON 2-3x per page)
     * langFetched       — Set of language codes already fetched (e.g. "en", "zh-cn")
     * langRows          — display rows from the first language JSON parsed; merged
     *                     into the "OneTrust Configuration" entry
     * pendingConfig     — { data, providerData, rows } for a parsed config JSON that
     *                     is waiting for langRows before being posted
     * pendingConfigTimer — timer id; posts the config alone if no language JSON
     *                     arrives in time (see CONFIG_WAIT_MS)
     * purposeMap        — { [purposeId.toUpperCase()]: categoryName }
     *                     Populated when the lang JSON is parsed; used to label
     *                     consent receipt purposes with human-readable names like
     *                     "Targeting" instead of a raw GUID.
     * groupIdMap        — { [CustomGroupId, e.g. "1"]: categoryName }
     *                     Populated when the lang JSON is parsed; used to label
     *                     OptanonConsent cookie groups.
     * hostname            — the tab's current top-level hostname, used to scope
     *                       OptanonConsent cookie reads to this tab.
     * lastOptanonValue    — last-posted OptanonConsent cookie value, so we don't
     *                       re-post an identical "Consent Preferences" row.
     * pendingOptanonValue — most recent cookie value seen, awaiting the debounce
     *                       timer below (see scheduleCookiePost).
     * optanonDebounceTimer — timer id for the pending debounced post.
     * receiptExtras       — InteractionType/test rows from a consent receipt,
     *                       appended to the next cookie entry (see postCookieRow).
     *
     * Reset on each top-level navigation.
     */
    const state = {};

    /* Open DevTools ports keyed by tab id; shared with serviceWorker.js */
    let tabs = {};

    /*
     * OneTrust's own scripts rewrite the OptanonConsent cookie several times in
     * quick succession during page init (GPC detection, geolocation, default
     * category state, etc.) — each rewrite is a genuinely different string, so
     * reacting to every chrome.cookies.onChanged event floods the panel with
     * rows for the same visit. Debounce: wait for writes to go quiet before
     * showing the settled value. A later, isolated change (e.g. a preference
     * center save) is outside this window and still posts immediately.
     */
    const COOKIE_DEBOUNCE_MS = 600;
    let cookieRequestCounter = 0;

    /*
     * The config and language JSON are separate requests that can finish in
     * either order, but are shown as one "Configuration" entry. The config entry
     * is held this long for the language rows before being posted without them.
     */
    const CONFIG_WAIT_MS = 3000;

    /**
     * The OneTrustProvider instance, used only to build the "provider" metadata
     * block for the synthetic "Consent Preferences" cookie-derived panel entry
     * (see postCookieRow) — this entry doesn't originate from a webRequest.
     */
    const providerInstance = new OneTrustProvider();

    function resetState(tabId) {
        if (state[tabId]) { clearTimeout(state[tabId].pendingConfigTimer); }
        state[tabId] = {
            configFetched:        false,
            langFetched:          new Set(),
            langRows:             null,
            pendingConfig:        null,
            pendingConfigTimer:   null,
            purposeMap:           {},
            groupIdMap:           {},
            hostname:             null,
            lastOptanonValue:     null,
            pendingOptanonValue:  null,
            optanonDebounceTimer: null,
            receiptExtras:        null
        };
    }

    function getState(tabId) {
        if (!state[tabId]) { resetState(tabId); }
        return state[tabId];
    }

    /**
     * Parse the consent receipt POST body and post a "Consent Preferences" entry.
     *
     * Uses the purposeMap cached from the lang JSON fetch to convert PurposeId
     * GUIDs into human-readable category names (Targeting, Performance, etc.)
     *
     * @param {object} data          Base request data
     * @param {object} providerData  Provider result (has _parseReceipt signal)
     * @param {number} tabId
     */
    function handleConsentReceipt(data, providerData, tabId) {
        const tabState = getState(tabId);
        const postBody = data.request.postData;

        let receipt = null;
        if (typeof postBody === "string" && postBody.trim().startsWith("{")) {
            try { receipt = JSON.parse(postBody); } catch(e) { /* fall through */ }
        }

        let rows;
        if (receipt) {
            rows = OneTrustProvider.parseConsentReceipt(receipt, tabState.purposeMap);
        } else {
            /* POST body unavailable or not JSON — show a minimal entry */
            rows = [
                { "key": "requestTypeParsed", "field": "Request Type", "value": "Consent Preferences", "group": "general" },
                { "key": "note", "field": "Note", "value": "POST body not available (sendBeacon)", "group": "consent" }
            ];
        }

        /* Standalone receipt entry — only used if the cookie can't be read */
        const postReceiptEntry = () => {
            tabState.receiptExtras = null;
            const finalProviderData = Object.assign({}, providerData, {
                data: rows.filter(d => !d.key.startsWith("_"))
            });

            if (tabId in tabs) {
                tabs[tabId].postMessage(Object.assign({}, data, finalProviderData));
            }
        };

        /*
         * The OptanonConsent cookie gives the full category table, so the receipt
         * only contributes InteractionType and test; they are appended to the
         * cookie entry (see postCookieRow) instead of posting a second entry.
         */
        tabState.receiptExtras = rows.filter(d => d.key === "interactionType" || d.key === "test");

        if (!tabState.hostname) {
            postReceiptEntry();
            return;
        }

        chrome.cookies.get({ "url": `https://${tabState.hostname}/`, "name": "OptanonConsent" }, (cookie) => {
            if (chrome.runtime.lastError || !cookie || !cookie.value) {
                postReceiptEntry();
                return;
            }
            scheduleCookiePost(tabId, cookie.value);
        });
    }

    /**
     * Fetch a OneTrust JSON config or lang URL and parse it. Deduplicates per
     * navigation:
     *  - Config JSON: only the first request per navigation is used
     *  - Lang JSON:   only the first request per language code per navigation is used
     *
     * The config JSON produces the "Configuration" panel entry; the first lang
     * JSON's display rows are merged into it (see postConfigEntry). The lang JSON
     * never gets an entry of its own.
     *
     * The lang JSON also caches the purposeMap and groupIdMap so that
     * subsequent consent receipt and cookie parses can use human-readable
     * category names.
     *
     * @param {object} data          Base request data
     * @param {object} providerData  Provider result (has _fetchJson signal)
     * @param {number} tabId
     */
    function fetchAndParseJson(data, providerData, tabId) {
        const url      = data.request.url;
        const tabState = getState(tabId);

        /* Determine JSON type */
        const guidRegex    = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-test)?\.json/i;
        const guidMatch    = url.match(guidRegex);
        const isConfigJson = !!guidMatch;
        const langMatch    = url.match(/\/([a-z]{2}(?:-[a-z]{2,4})?)\.json$/i);
        const isLangJson   = !!langMatch;
        const langCode     = isLangJson ? langMatch[1].toLowerCase() : null;

        /* Deduplication */
        if (isConfigJson) {
            if (tabState.configFetched) { return; }
            tabState.configFetched = true;
        } else if (isLangJson) {
            if (tabState.langFetched.has(langCode)) { return; }
            tabState.langFetched.add(langCode);
        }

        fetch(url, { credentials: "omit" })
            .then(response => {
                if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
                return response.json();
            })
            .then(json => {
                const hasLangShape   = json.DomainData && Array.isArray(json.DomainData.Groups);
                const hasConfigShape = json.RuleSet && json.Domain;

                if (hasLangShape) {
                    /* parseLangJson returns { rows, purposeMap, groupIdMap } */
                    const result = OneTrustProvider.parseLangJson(json);
                    /* Cache the ID→name maps for receipt and cookie decoding */
                    Object.assign(tabState.purposeMap, result.purposeMap);
                    Object.assign(tabState.groupIdMap, result.groupIdMap);
                    /* Only the first language's display rows are merged into Configuration */
                    if (!tabState.langRows) { tabState.langRows = result.rows; }
                    /* Re-check the cookie now that we can resolve category names from it */
                    checkCookie(tabId);
                    postConfigEntry(tabId, tabState);
                } else if (hasConfigShape) {
                    tabState.pendingConfig = {
                        data,
                        providerData,
                        rows: OneTrustProvider.parseConfigJson(json, guidMatch ? guidMatch[1] : null)
                    };
                    if (tabState.langRows) {
                        postConfigEntry(tabId, tabState);
                    } else {
                        tabState.pendingConfigTimer = setTimeout(() => postConfigEntry(tabId, tabState), CONFIG_WAIT_MS);
                    }
                } else {
                    throw new Error("Unrecognised OneTrust JSON structure");
                }
            })
            .catch(err => {
                console.warn("OneTrust JSON fetch failed:", err.message, url);
                if (isLangJson) {
                    /* Nothing to show for a lang JSON; don't keep the config entry waiting */
                    postConfigEntry(tabId, tabState);
                    return;
                }
                /* Fallback: show basic entry with URL only */
                const fallback = Object.assign({}, providerData, {
                    data: (providerData.data || []).filter(d => !d.key.startsWith("_"))
                });
                if (tabId in tabs) {
                    tabs[tabId].postMessage(Object.assign({}, data, fallback));
                }
            });
    }

    /**
     * Post the held "Configuration" entry, with the lang JSON's rows appended if
     * they are available. No-op if there is no held config entry.
     *
     * @param {number} tabId
     * @param {object} tabState  State object the config entry was held on
     */
    function postConfigEntry(tabId, tabState) {
        const pending = tabState.pendingConfig;
        if (!pending) { return; }
        clearTimeout(tabState.pendingConfigTimer);
        tabState.pendingConfig = null;

        const rows = pending.rows.concat(tabState.langRows || []);
        const finalProviderData = Object.assign({}, pending.providerData, {
            data: rows.filter(d => !d.key.startsWith("_"))
        });

        if (tabId in tabs) {
            tabs[tabId].postMessage(Object.assign({}, pending.data, finalProviderData));
        }
    }

    /**
     * Read the OptanonConsent cookie for a tab's current hostname and, if present,
     * schedule it to be shown (see scheduleCookiePost).
     *
     * @param {number} tabId
     */
    function checkCookie(tabId) {
        const tabState = state[tabId];
        if (!tabState || !tabState.hostname || !(tabId in tabs)) { return; }

        chrome.cookies.get({ "url": `https://${tabState.hostname}/`, "name": "OptanonConsent" }, (cookie) => {
            if (chrome.runtime.lastError || !cookie || !cookie.value) { return; }
            scheduleCookiePost(tabId, cookie.value);
        });
    }

    /**
     * Debounce a burst of OptanonConsent cookie writes down to a single post of
     * the settled value.
     *
     * @param {number} tabId
     * @param {string} cookieValue
     */
    function scheduleCookiePost(tabId, cookieValue) {
        const tabState = state[tabId];
        if (!tabState) { return; }

        tabState.pendingOptanonValue = cookieValue;
        clearTimeout(tabState.optanonDebounceTimer);
        tabState.optanonDebounceTimer = setTimeout(() => {
            postCookieRow(tabId, tabState.pendingOptanonValue);
        }, COOKIE_DEBOUNCE_MS);
    }

    /**
     * Parse an OptanonConsent cookie value and post it as a "Consent Preferences"
     * panel entry, deduplicated against the last value posted for this navigation.
     *
     * @param {number} tabId
     * @param {string} cookieValue
     */
    function postCookieRow(tabId, cookieValue) {
        const tabState = state[tabId];
        if (!tabState || !(tabId in tabs)) { return; }

        /* A receipt always produces an entry, even if the cookie value didn't change */
        const receiptExtras = tabState.receiptExtras;
        if (!receiptExtras && tabState.lastOptanonValue === cookieValue) { return; }
        tabState.receiptExtras  = null;
        tabState.lastOptanonValue = cookieValue;

        const rows = OneTrustProvider.parseOptanonCookie(cookieValue, tabState.groupIdMap)
            .concat(receiptExtras || []);

        tabs[tabId].postMessage({
            "request": {
                "initiator": null,
                "method":    "COOKIE",
                "id":        `onetrust-cookie-${++cookieRequestCounter}`,
                "tab":       tabId,
                "timestamp": Date.now(),
                "type":      "other",
                "url":       `https://${tabState.hostname}/`,
                "postData":  "",
                "postError": false
            },
            "event": "webRequest",
            "provider": {
                "name":    providerInstance.name,
                "key":     providerInstance.key,
                "type":    providerInstance.type,
                "columns": providerInstance.columnMapping,
                "groups":  providerInstance.groups
            },
            "data": rows.filter(d => !d.key.startsWith("_"))
        });
    }

    return {
        /**
         * @param {object} openTabs  Map of tab id → DevTools port (owned by serviceWorker.js)
         */
        init(openTabs) {
            tabs = openTabs;

            /*
             * Live updates to the OptanonConsent cookie — e.g. the user opens the
             * preference center and changes categories after the initial page load.
             */
            chrome.cookies.onChanged.addListener((changeInfo) => {
                if (changeInfo.removed || changeInfo.cookie.name !== "OptanonConsent") { return; }

                const cookieDomain = changeInfo.cookie.domain.replace(/^\./, "");
                Object.keys(tabs).forEach((tabIdStr) => {
                    const tabId    = Number(tabIdStr);
                    const tabState = state[tabId];
                    if (tabState && tabState.hostname &&
                        (tabState.hostname === cookieDomain || tabState.hostname.endsWith(`.${cookieDomain}`))) {
                        scheduleCookiePost(tabId, changeInfo.cookie.value);
                    }
                });
            });
        },

        /**
         * Handle a provider result carrying one of OneTrust's signal keys.
         *
         * @param {object} data          Base request data
         * @param {object} providerData  Provider result
         * @param {number} tabId
         * @return {boolean} true if handled here (caller must not post it)
         */
        handleProviderData(data, providerData, tabId) {
            if (!Array.isArray(providerData.data)) { return false; }

            /* Noise (banner assets, geolocation, etc.) — drop it without posting */
            if (providerData.data.some(d => d.key === "_suppress")) {
                return true;
            }
            if (providerData.data.some(d => d.key === "_parseReceipt")) {
                handleConsentReceipt(data, providerData, tabId);
                return true;
            }
            if (providerData.data.some(d => d.key === "_fetchJson")) {
                fetchAndParseJson(data, providerData, tabId);
                return true;
            }
            return false;
        },

        /**
         * Top-level navigation — reset dedup/cache state for the tab.
         *
         * @param {number} tabId
         * @param {string} url
         */
        onNavigation(tabId, url) {
            resetState(tabId);

            try {
                state[tabId].hostname = new URL(url).hostname;
            } catch (e) { /* non-http(s) URL — no cookie to read */ }

            /*
             * The OptanonConsent cookie is written by otSDKStub.js almost immediately,
             * but before any script has run at document-commit time. chrome.cookies.onChanged
             * (registered in init) catches it as soon as it's written; this delayed read is a
             * fallback for the case where the cookie's value is byte-identical to a prior
             * navigation's (so no change event fires) yet Omnibug was just reopened/reset.
             */
            setTimeout(() => checkCookie(tabId), 1000);
        }
    };
})();
