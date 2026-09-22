/* global OmnibugSettings, OmnibugProvider, OmnibugPort, OneTrustProvider */

/**
 * Set/Load/Migrate settings when extension / browser is installed / updated.
 */
chrome.runtime.onInstalled.addListener((details) => {
    let settings = new OmnibugSettings();
    settings.migrate();
});

/**
 * Load settings when storage has changed
 */
chrome.storage.onChanged.addListener((changes, storageType) => {
    const settings = new OmnibugSettings();
    settings.load().then(sendSettingsToTabs);
});

/*
 Persistent(ish) storage of the open tabs.
 Not ideal, but the keep alive script should keep this variable in existence.
 */
const tabs = {};

// Keep alive funcs
const forceReconnect = (port) => {
    console.log(`Reconnecting port ${port.name} to stay alive`);
    deleteTimer(port);
    port.disconnect();
};
const deleteTimer = (port) => {
    console.log(`Port ${port.name} disconnected`);
    if (port._timer) {
        clearTimeout(port._timer);
        delete port._timer;
        delete tabs[port.name];
    }
};
var providerPattern;

/*
 * Per-tab OneTrust state.
 *
 * configFetched     — prevents duplicate "OneTrust Configuration" panel entries
 *                     (OneTrust loads the config JSON 2-3x per page)
 * langFetched       — Set of language codes already shown (e.g. "en", "zh-cn")
 * purposeMap        — { [purposeId.toUpperCase()]: categoryName }
 *                     Populated when the lang JSON is parsed; used to label
 *                     consent receipt purposes with human-readable names like
 *                     "Targeting" instead of a raw GUID.
 * groupIdMap        — { [CustomGroupId, e.g. "1"]: categoryName }
 *                     Populated when the lang JSON is parsed; used to label
 *                     OptanonConsent cookie groups (see groupIdMap above).
 * hostname            — the tab's current top-level hostname, used to scope
 *                       OptanonConsent cookie reads to this tab.
 * lastOptanonValue    — last-posted OptanonConsent cookie value, so we don't
 *                       re-post an identical "Consent Preferences" row.
 * pendingOptanonValue — most recent cookie value seen, awaiting the debounce
 *                       timer below (see scheduleOnetrustCookiePost).
 * optanonDebounceTimer — timer id for the pending debounced post.
 *
 * Reset on each top-level navigation.
 */
const oneTrustFetchState = {};

function resetOneTrustState(tabId) {
    oneTrustFetchState[tabId] = {
        configFetched:        false,
        langFetched:          new Set(),
        purposeMap:           {},
        groupIdMap:           {},
        hostname:             null,
        lastOptanonValue:     null,
        pendingOptanonValue:  null,
        optanonDebounceTimer: null
    };
}

function getOneTrustState(tabId) {
    if (!oneTrustFetchState[tabId]) { resetOneTrustState(tabId); }
    return oneTrustFetchState[tabId];
}

/**
 * Accept incoming connections from our devtools panels.
 */
chrome.runtime.onConnect.addListener((port) => {
    console.log(`Port ${port.name} connected`);

    port.onDisconnect.addListener(deleteTimer);
    port._timer = setTimeout(forceReconnect, 250e3, port);
    tabs[port.name] = port;

    const settings = new OmnibugSettings();

    settings.load().then((loadedSettings) => {
        port.postMessage({ "event": "settings", "data": loadedSettings });
        providerPattern = OmnibugProvider.getPattern(loadedSettings.providers);
    });

    port.onMessage.addListener((messages) => {
        messages.forEach((message) => {
            if (message.type === "settings") {
                if (typeof message.key === "string" && message.value) {
                    settings.updateItem(message.key, message.value);
                } else {
                    settings.save(message.value);
                }
            } else if (message.type === "linkClick" && message.url) {
                chrome.tabs.create({ url: message.url });
            } else if (message.type === "openSettings") {
                chrome.runtime.openOptionsPage();
            }
        });
    });
});

/**
 * Listen for all requests that match our providers.
 */
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (!validProviderRequest(details)) { return; }

        let data = {
            "request": {
                "initiator": details.initiator,
                "method":    details.method,
                "id":        details.requestId,
                "tab":       details.tabId,
                "timestamp": details.timeStamp,
                "type":      details.type,
                "url":       details.url,
                "postData":  "",
                "postError": false
            },
            "event": "webRequest"
        };

        if (details.method === "POST" && typeof details.requestBody !== "undefined" && details.requestBody) {
            const body = details.requestBody;
            if (typeof body.error !== "undefined" && body.error) {
                data.request.postError = true;
            } else if (typeof body.raw !== "undefined" && body.raw[0]) {
                data.request.postData = (new Uint8Array(body.raw[0].bytes)).reduce((s, b) => s + String.fromCharCode(b), "");
            } else if (typeof body.formData === "object") {
                data.request.postData = body.formData;
            }
        }

        let providerDataArray = OmnibugProvider.parseUrl(data.request.url, data.request.postData);
        if (!Array.isArray(providerDataArray)) {
            providerDataArray = [providerDataArray];
        } else {
            data.multipleEntriesPerRequest = true;
        }

        providerDataArray.forEach(providerData => {

            /* ---- Suppression ---- */
            const isSuppressed = Array.isArray(providerData.data) &&
                providerData.data.some(d => d.key === "_suppress");
            if (isSuppressed) { return; }

            /* ---- Consent receipt parsing ---- */
            /* Provider set _parseReceipt — decode the raw JSON POST body */
            const isReceipt = Array.isArray(providerData.data) &&
                providerData.data.some(d => d.key === "_parseReceipt");
            if (isReceipt) {
                handleConsentReceipt(data, providerData, details.tabId);
                return;
            }

            /* ---- Config/lang JSON enrichment ---- */
            /* Provider set _fetchEnrich — fetch the response body and parse */
            const needsEnrich = Array.isArray(providerData.data) &&
                providerData.data.some(d => d.key === "_fetchEnrich");
            if (needsEnrich) {
                enrichOneTrustJson(data, providerData, details.tabId);
                return;
            }

            /* ---- Normal path ---- */
            tabs[details.tabId].postMessage(Object.assign({}, data, providerData));
        });
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
);

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
    const state      = getOneTrustState(tabId);
    const postBody   = data.request.postData;

    let receipt = null;
    if (typeof postBody === "string" && postBody.trim().startsWith("{")) {
        try { receipt = JSON.parse(postBody); } catch(e) { /* fall through */ }
    }

    let enrichedRows;
    if (receipt) {
        enrichedRows = OneTrustProvider.parseConsentReceipt(receipt, state.purposeMap);
    } else {
        /* POST body unavailable or not JSON — show a minimal entry */
        enrichedRows = [
            { "key": "requestTypeParsed", "field": "Request Type", "value": "Consent Preferences", "group": "general" },
            { "key": "note", "field": "Note", "value": "POST body not available (sendBeacon)", "group": "consent" }
        ];
    }

    const finalProviderData = Object.assign({}, providerData, {
        data: enrichedRows.filter(d => !d.key.startsWith("_"))
    });

    if (tabId in tabs) {
        tabs[tabId].postMessage(Object.assign({}, data, finalProviderData));
    }
}

/**
 * Fetch a OneTrust JSON config or lang URL, parse it, and post the enriched
 * panel entry. Deduplicates per navigation:
 *  - Config JSON: only the first request per navigation is shown
 *  - Lang JSON:   only the first request per language code per navigation is shown
 *
 * Also caches the purposeMap from the lang JSON in oneTrustFetchState so that
 * subsequent consent receipt parses can use human-readable category names.
 *
 * @param {object} data          Base request data
 * @param {object} providerData  Provider result (has _fetchEnrich signal)
 * @param {number} tabId
 */
function enrichOneTrustJson(data, providerData, tabId) {
    const url   = data.request.url;
    const state = getOneTrustState(tabId);

    /* Determine JSON type */
    const isConfigJson = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-test)?\.json/i.test(url);
    const langMatch    = url.match(/\/([a-z]{2}(?:-[a-z]{2,4})?)\.json$/i);
    const isLangJson   = !!langMatch;
    const langCode     = isLangJson ? langMatch[1].toLowerCase() : null;

    /* Deduplication */
    if (isConfigJson) {
        if (state.configFetched) { return; }
        state.configFetched = true;
    } else if (isLangJson) {
        if (state.langFetched.has(langCode)) { return; }
        state.langFetched.add(langCode);
    }

    fetch(url, { credentials: "omit" })
        .then(response => {
            if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
            return response.json();
        })
        .then(json => {
            let enrichedRows;

            const guidMatch     = url.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-test)?\.json/i);
            const hasLangShape  = json.DomainData && Array.isArray(json.DomainData.Groups);
            const hasConfigShape = json.RuleSet && json.Domain;

            if (hasLangShape) {
                /* parseLangJson returns { rows, purposeMap, groupIdMap } */
                const result = OneTrustProvider.parseLangJson(json);
                enrichedRows = result.rows;
                /* Cache the ID→name maps for receipt and cookie decoding */
                Object.assign(state.purposeMap, result.purposeMap);
                Object.assign(state.groupIdMap, result.groupIdMap);
                /* Re-check the cookie now that we can resolve category names from it */
                checkOnetrustCookie(tabId);
            } else if (hasConfigShape) {
                const guid = guidMatch ? guidMatch[1] : null;
                enrichedRows = OneTrustProvider.parseConfigJson(json, guid);
            } else {
                throw new Error("Unrecognised OneTrust JSON structure");
            }

            const finalProviderData = Object.assign({}, providerData, {
                data: enrichedRows.filter(d => !d.key.startsWith("_"))
            });

            if (tabId in tabs) {
                tabs[tabId].postMessage(Object.assign({}, data, finalProviderData));
            }
        })
        .catch(err => {
            console.warn("OneTrust JSON fetch failed:", err.message, url);
            /* Fallback: show basic entry with URL only */
            const fallback = Object.assign({}, providerData, {
                data: (providerData.data || []).filter(d => !d.key.startsWith("_"))
            });
            if (tabId in tabs) {
                tabs[tabId].postMessage(Object.assign({}, data, fallback));
            }
        });
}

// HTTP 4xx/5xx errors
chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        if (!validProviderRequest(details) || details.statusCode < 400) { return; }
        tabs[details.tabId].postMessage({
            "request": { "id": details.requestId, "error": details.statusCode },
            "event": "requestError"
        });
    },
    { urls: ["<all_urls>"] }
);

// Cancelled/blocked requests
chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
        if (!validProviderRequest(details)) { return; }
        tabs[details.tabId].postMessage({
            "request": { "id": details.requestId, "error": details.error },
            "event": "requestError"
        });
    },
    { urls: ["<all_urls>"] }
);

/**
 * Top-level navigation — reset OneTrust dedup/cache state for the tab.
 */
chrome.webNavigation.onCommitted.addListener(
    (details) => {
        if (!tabHasOmnibugOpen(details.tabId) || details.frameId !== 0) { return; }

        resetOneTrustState(details.tabId);

        try {
            oneTrustFetchState[details.tabId].hostname = new URL(details.url).hostname;
        } catch (e) { /* non-http(s) URL — no cookie to read */ }

        /*
         * The OptanonConsent cookie is written by otSDKStub.js almost immediately,
         * but before any script has run at document-commit time. chrome.cookies.onChanged
         * (registered below) catches it as soon as it's written; this delayed read is a
         * fallback for the case where the cookie's value is byte-identical to a prior
         * navigation's (so no change event fires) yet Omnibug was just reopened/reset.
         */
        setTimeout(() => checkOnetrustCookie(details.tabId), 1000);

        tabs[details.tabId].postMessage({
            "request": { "tab": details.tabId, "timestamp": details.timeStamp, "url": details.url },
            "event": "webNavigation"
        });
    }
);

/**
 * The OneTrustProvider instance, used only to build the "provider" metadata
 * block for the synthetic "Consent Preferences" cookie-derived panel entry
 * (see postOnetrustCookieRow) — this entry doesn't originate from a webRequest.
 */
const oneTrustProviderInstance = new OneTrustProvider();

/**
 * Read the OptanonConsent cookie for a tab's current hostname and, if present,
 * schedule it to be shown (see scheduleOnetrustCookiePost).
 *
 * @param {number} tabId
 */
function checkOnetrustCookie(tabId) {
    const state = oneTrustFetchState[tabId];
    if (!state || !state.hostname || !(tabId in tabs)) { return; }

    chrome.cookies.get({ "url": `https://${state.hostname}/`, "name": "OptanonConsent" }, (cookie) => {
        if (chrome.runtime.lastError || !cookie || !cookie.value) { return; }
        scheduleOnetrustCookiePost(tabId, cookie.value);
    });
}

/*
 * OneTrust's own scripts rewrite the OptanonConsent cookie several times in
 * quick succession during page init (GPC detection, geolocation, default
 * category state, etc.) — each rewrite is a genuinely different string, so
 * reacting to every chrome.cookies.onChanged event floods the panel with
 * rows for the same visit. Debounce: wait for writes to go quiet before
 * showing the settled value. A later, isolated change (e.g. a preference
 * center save) is outside this window and still posts immediately.
 */
const ONETRUST_COOKIE_DEBOUNCE_MS = 600;
let onetrustCookieRequestCounter = 0;

/**
 * Debounce a burst of OptanonConsent cookie writes down to a single post of
 * the settled value.
 *
 * @param {number} tabId
 * @param {string} cookieValue
 */
function scheduleOnetrustCookiePost(tabId, cookieValue) {
    const state = oneTrustFetchState[tabId];
    if (!state) { return; }

    state.pendingOptanonValue = cookieValue;
    clearTimeout(state.optanonDebounceTimer);
    state.optanonDebounceTimer = setTimeout(() => {
        postOnetrustCookieRow(tabId, state.pendingOptanonValue);
    }, ONETRUST_COOKIE_DEBOUNCE_MS);
}

/**
 * Parse an OptanonConsent cookie value and post it as a "Consent Preferences"
 * panel entry, deduplicated against the last value posted for this navigation.
 *
 * @param {number} tabId
 * @param {string} cookieValue
 */
function postOnetrustCookieRow(tabId, cookieValue) {
    const state = oneTrustFetchState[tabId];
    if (!state || state.lastOptanonValue === cookieValue || !(tabId in tabs)) { return; }
    state.lastOptanonValue = cookieValue;

    const rows = OneTrustProvider.parseOptanonCookie(cookieValue, state.groupIdMap);

    tabs[tabId].postMessage({
        "request": {
            "initiator": null,
            "method":    "COOKIE",
            "id":        `onetrust-cookie-${++onetrustCookieRequestCounter}`,
            "tab":       tabId,
            "timestamp": Date.now(),
            "type":      "other",
            "url":       `https://${state.hostname}/`,
            "postData":  "",
            "postError": false
        },
        "event": "webRequest",
        "provider": {
            "name":    oneTrustProviderInstance.name,
            "key":     oneTrustProviderInstance.key,
            "type":    oneTrustProviderInstance.type,
            "columns": oneTrustProviderInstance.columnMapping,
            "groups":  oneTrustProviderInstance.groups
        },
        "data": rows.filter(d => !d.key.startsWith("_"))
    });
}

/**
 * Live updates to the OptanonConsent cookie — e.g. the user opens the
 * preference center and changes categories after the initial page load.
 */
chrome.cookies.onChanged.addListener((changeInfo) => {
    if (changeInfo.removed || changeInfo.cookie.name !== "OptanonConsent") { return; }

    const cookieDomain = changeInfo.cookie.domain.replace(/^\./, "");
    Object.keys(tabs).forEach((tabIdStr) => {
        const tabId = Number(tabIdStr);
        const state = oneTrustFetchState[tabId];
        if (state && state.hostname &&
            (state.hostname === cookieDomain || state.hostname.endsWith(`.${cookieDomain}`))) {
            scheduleOnetrustCookiePost(tabId, changeInfo.cookie.value);
        }
    });
});

function validProviderRequest(details) {
    if (typeof providerPattern === "undefined" || !(providerPattern instanceof RegExp)) {
        providerPattern = OmnibugProvider.getPattern();
    }
    return details.method !== "OPTIONS" &&
        tabHasOmnibugOpen(details.tabId) &&
        providerPattern.test(details.url) &&
        !/\/.well-known\//i.test(details.url);
}

function tabHasOmnibugOpen(tabId) {
    return (tabId !== -1 && tabId in tabs);
}

function sendSettingsToTabs(settings) {
    console.log("Sending settings to tabs", settings);
    Object.values(tabs).forEach((tab) => {
        tab.postMessage({ "event": "settings", "data": settings });
    });
    providerPattern = OmnibugProvider.getPattern(settings.providers);
}