/**
 * OneTrust
 * https://www.onetrust.com/
 *
 * Panel entries produced:
 *
 *  Page load (once each):
 *   - "OneTrust Configuration" — from the main config JSON (fd2193c8...-test.json)
 *     Groups: General, Template & Rules
 *   - "OneTrust Cookie Data" — from the language JSON (en.json etc.)
 *     Groups: General, Template & Rules
 *     Also caches the PurposeId → category name map for use by consent receipts.
 *
 *  On page load AND when the user saves preferences:
 *   - "Consent Preferences" — from the POST to privacyportal.onetrust.com
 *     Groups: General, Consent Preferences
 *     Shows category names (Targeting, Performance, etc.) mapped from PurposeId GUIDs,
 *     plus InteractionType, purposeIds, country, isAnonymous, type, test.
 *
 *  All other OneTrust traffic is suppressed, including banner/preference-center
 *  layout JSON (e.g. bLayout-en.json, pcLayout-en.json) — these carry pre-rendered
 *  HTML/CSS for the widget UI, not consent data, so there's nothing to parse.
 *
 * @class
 * @extends BaseProvider
 */
class OneTrustProvider extends BaseProvider {
    constructor() {
        super();
        this._key      = "ONETRUST";
        this._pattern  = /(?:cdn\.cookielaw\.org|geolocation\.onetrust\.com|sync\.cookielaw\.org|optanon\.blob\.core\.windows\.net|privacyportal(?:-de|-eu|-au|-sg)?\.onetrust\.com)/;
        this._name     = "OneTrust";
        this._type     = "customer";
        this._keywords = [
            "consent", "cmp", "cookie consent", "gdpr", "ccpa",
            "optanon", "cookielaw", "cookie law", "privacy"
        ];
    }

    get columnMapping() {
        return {
            "account":     "domainScriptId",
            "requestType": "requestTypeParsed"
        };
    }

    get groups() {
        return [
            { "key": "general",  "name": "General" },
            { "key": "template", "name": "Template & Rules" },
            { "key": "consent",  "name": "Consent Preferences" }
        ];
    }

    get keys() {
        return {};
    }

    /**
     * URL-only parse — routes each request to the correct handling path.
     *
     *  - privacyportal.*  → signal _parseReceipt (service worker handles with POST body)
     *  - /consent/*.json  → signal _fetchEnrich  (service worker fetches response body)
     *  - everything else  → signal _suppress
     */
    handleCustom(url, params) {
        const pathname = url.pathname;
        const hostname = url.hostname;

        /* ---- Consent receipt POST ---- */
        if (/privacyportal/i.test(hostname)) {
            return [{
                "key":    "_parseReceipt",
                "value":  "true",
                "hidden": true
            }, {
                "key":   "requestTypeParsed",
                "field": "Request Type",
                "value": "Consent Preferences",
                "group": "general"
            }];
        }

        /* ---- OneTrust CDN JSON files (config + language only — layout/UI JSON falls through to suppression) ---- */
        if (/\.json$/i.test(pathname) && /\/consent\//i.test(pathname)) {
            const filename     = pathname.substring(pathname.lastIndexOf("/") + 1);
            const isConfigFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-test)?\.json$/i.test(filename);
            const isLangFile   = /^[a-z]{2}(?:-[a-z]{2,4})?\.json$/i.test(filename);

            if (isConfigFile || isLangFile) {
                const guidMatch = pathname.match(
                    /\/(?:scripttemplates|consent)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
                );
                const guid = guidMatch ? guidMatch[1] : null;
                return [
                    { "key": "requestTypeParsed", "field": "Request Type", "value": isConfigFile ? "OneTrust Configuration" : "OneTrust Cookie Data", "group": "general" },
                    { "key": "_fetchEnrich", "value": "true", "hidden": true },
                    ...(guid ? [{ "key": "domainScriptId", "field": "Domain Script ID", "value": guid, "group": "general" }] : [])
                ];
            }
        }

        /* ---- Suppress everything else ---- */
        return [
            { "key": "_suppress", "value": "true", "hidden": true },
            { "key": "requestTypeParsed", "field": "Request Type", "value": "OneTrust (suppressed)", "group": "general" }
        ];
    }

    /* ====================================================================
     * STATIC PARSERS — called directly by serviceWorker.js
     * ==================================================================== */

    /**
     * Parse the main OneTrust config JSON (e.g. fd2193c8...-test.json).
     *
     * @param  {object} json   Parsed JSON object
     * @param  {string} guid   Domain Script ID (from URL)
     * @returns {Array}        Omnibug data rows
     */
    static parseConfigJson(json, guid) {
        const results = [];

        results.push({ "key": "requestTypeParsed", "field": "Request Type", "value": "OneTrust Configuration", "group": "general" });

        if (guid)           { results.push({ "key": "domainScriptId", "field": "Domain Script ID", "value": guid,           "group": "general" }); }
        if (json.Domain)    { results.push({ "key": "domain",         "field": "Domain",           "value": json.Domain,     "group": "general" }); }
        if (json.Version)   { results.push({ "key": "version",        "field": "SDK Version",      "value": json.Version,    "group": "general" }); }
        if (json.ScriptType){ results.push({ "key": "scriptType",     "field": "Script Type",      "value": json.ScriptType, "group": "general" }); }
        /* EnvId intentionally omitted — potential security exposure */

        const ruleset    = Array.isArray(json.RuleSet) ? json.RuleSet : [];
        const activeRule = ruleset.find(r => r.Default) || ruleset[0];

        if (activeRule) {
            results.push({ "key": "templateName", "field": "Template Name",          "value": activeRule.TemplateName || "(none)", "group": "template" });
            results.push({ "key": "rulesetName",  "field": "Ruleset Name",           "value": activeRule.Name         || "(none)", "group": "template" });
            results.push({ "key": "ruleType",     "field": "Consent Type",           "value": activeRule.Type         || "(none)", "group": "template" });

            const lsp = activeRule.LanguageSwitcherPlaceholder;
            if (lsp) {
                results.push({ "key": "supportedLanguages", "field": "Supported Languages", "value": Object.values(lsp).join(", "), "group": "template" });
            }
        }

        if (json.GeoRuleGroupName)                        { results.push({ "key": "geoRuleGroup",  "field": "Geo Rule Group",         "value": json.GeoRuleGroupName,                                "group": "template" }); }
        if (json.PublisherCC)                             { results.push({ "key": "publisherCC",   "field": "Publisher Country Code", "value": json.PublisherCC,                                     "group": "template" }); }
        if (typeof json.IsSuppressBanner !== "undefined") { results.push({ "key": "suppressBanner","field": "Banner Suppressed",      "value": json.IsSuppressBanner ? "Yes" : "No",                 "group": "template" }); }
        if (typeof json.LanguageDetectionEnabled !== "undefined") { results.push({ "key": "langDetect", "field": "Language Detection", "value": json.LanguageDetectionEnabled ? "Enabled" : "Disabled", "group": "template" }); }

        return results;
    }

    /**
     * Parse the OneTrust language JSON (e.g. en.json, zh-cn.json).
     * Returns both display rows AND a purposeMap for receipt decoding.
     *
     * @param  {object} json   Parsed JSON object
     * @returns {{ rows: Array, purposeMap: object }}
     *   rows       — Omnibug data rows for the panel
     *   purposeMap — { [purposeId: string]: categoryName: string }
     */
    static parseLangJson(json) {
        const rows = [];
        const purposeMap = {};
        const dd = json.DomainData;
        if (!dd) { return { rows, purposeMap }; }

        rows.push({ "key": "requestTypeParsed", "field": "Request Type", "value": "OneTrust Cookie Data", "group": "general" });

        const culture = dd.Language && dd.Language.Culture;
        if (culture) {
            rows.push({ "key": "configLanguage", "field": "Config Language", "value": culture.toUpperCase(), "group": "general" });
        }

        const layoutFlags = [
            ["Flat", "Flat"], ["FloatingFlat", "Floating Flat"],
            ["FloatingRoundedCorner", "Floating Rounded Corner"],
            ["FloatingRoundedIcon", "Floating Rounded Icon"],
            ["Center", "Center"], ["Panel", "Panel"], ["Popup", "Popup"]
        ];
        const activeLayout = layoutFlags.find(([key]) => dd[key]);
        if (activeLayout)                                         { rows.push({ "key": "bannerLayout",   "field": "Banner Layout",       "value": activeLayout[1],                                    "group": "template" }); }
        if (dd.BannerPosition)                                    { rows.push({ "key": "bannerPosition", "field": "Banner Position",     "value": dd.BannerPosition,                                  "group": "template" }); }
        if (dd.ConsentModel)                                      { rows.push({ "key": "consentModel",   "field": "Consent Model",       "value": dd.ConsentModel,                                    "group": "template" }); }
        if (typeof dd.GCEnable !== "undefined")                   { rows.push({ "key": "gcm",            "field": "Google Consent Mode", "value": dd.GCEnable ? "Enabled" : "Disabled",               "group": "template" }); }
        if (typeof dd.ForceConsent !== "undefined")               { rows.push({ "key": "forceConsent",   "field": "Force Consent",       "value": dd.ForceConsent ? "Yes" : "No",                     "group": "template" }); }
        if (typeof dd.IsConsentLoggingEnabled !== "undefined")    { rows.push({ "key": "consentLogging", "field": "Consent Logging",     "value": dd.IsConsentLoggingEnabled ? "Enabled" : "Disabled", "group": "template" }); }

        /* Build PurposeId → category name map for consent receipt decoding */
        const groups = Array.isArray(dd.Groups) ? dd.Groups : [];
        groups.forEach((group) => {
            if (group.PurposeId && group.GroupName) {
                purposeMap[group.PurposeId.toUpperCase()] = group.GroupName;
            }
        });

        // TODO: Add cookie category detail rows (counts + per-cookie names/hosts/durations).
        // Data: json.DomainData.Groups[n].FirstPartyCookies + Groups[n].Hosts[n].Cookies
        // Tabled pending memory/performance evaluation (Christie's has 223+ cookies).

        return { rows, purposeMap };
    }

    /**
     * Parse a consent receipt POST body into human-readable consent preference rows.
     *
     * Called by the service worker with the raw POST body string and the
     * purposeMap cached from parseLangJson.
     *
     * Consent receipt payload shape (JSON):
     * {
     *   identifier: "...",
     *   isAnonymous: true,
     *   test: true,
     *   purposes: [ { id: "<purposeId-guid>", status: "ACTIVE" | "OPT_OUT" | ... }, ... ],
     *   source: { purposeIds: ["<guid>"], type: "WEB" },
     *   dsDataElements: { InteractionType: "Preference Center - Confirm", Country: "US", ... },
     *   geolocation: { country: "US", ... }
     * }
     *
     * @param  {object} receipt     Parsed JSON receipt body
     * @param  {object} purposeMap  { [purposeId: string]: categoryName } from parseLangJson
     * @returns {Array}             Omnibug data rows
     */
    static parseConsentReceipt(receipt, purposeMap) {
        const results = [];

        results.push({ "key": "requestTypeParsed", "field": "Request Type", "value": "Consent Preferences", "group": "general" });

        /* ---- Consent Preferences section ---- */

        /* Per-purpose consent decisions — map GUID → human name */
        const statusLabels = {
            "ACTIVE":        "Opted-in",
            "OPT_OUT":       "Opted-out",
            "ALWAYS_ACTIVE": "Always Opted-in",
            "NO_CONSENT":    "No Consent",
            "WITHDRAWN":     "Withdrawn",
            "EXPIRED":       "Expired",
            "PENDING":       "Pending",
            "NOTGIVEN":      "Not Given",
            "NO_OPT_OUT":    "Not Opted-out"
        };

        const purposes = Array.isArray(receipt.purposes) ? receipt.purposes : [];
        purposes.forEach((p, idx) => {
            if (!p || !p.id) { return; }
            const purposeId  = p.id.toUpperCase();
            const catName    = (purposeMap && purposeMap[purposeId]) || p.id;
            const statusText = statusLabels[p.status] || p.status || "(unknown)";
            results.push({
                "key":   `purpose_${idx}`,
                "field": catName,
                "value": statusText,
                "group": "consent"
            });
        });

        /* InteractionType — how the user interacted (e.g. "Preference Center - Confirm") */
        const interactionType = receipt.dsDataElements && receipt.dsDataElements.InteractionType;
        if (interactionType) {
            results.push({ "key": "interactionType", "field": "InteractionType", "value": interactionType, "group": "consent" });
        }

        /* purposeIds — analytics category purpose ID (from source.purposeIds) */
        const sourcePurposeIds = receipt.source && Array.isArray(receipt.source.purposeIds)
            ? receipt.source.purposeIds.join(", ")
            : null;
        if (sourcePurposeIds) {
            results.push({ "key": "sourcePurposeIds", "field": "purposeIds", "value": sourcePurposeIds, "group": "consent" });
        }

        /* country */
        const country = (receipt.geolocation && receipt.geolocation.country)
            || (receipt.dsDataElements && receipt.dsDataElements.Country);
        if (country) {
            results.push({ "key": "country", "field": "country", "value": country, "group": "consent" });
        }

        /* isAnonymous */
        if (typeof receipt.isAnonymous !== "undefined") {
            results.push({ "key": "isAnonymous", "field": "isAnonymous", "value": String(receipt.isAnonymous), "group": "consent" });
        }

        /* type (WEB) */
        const sourceType = receipt.source && receipt.source.type;
        if (sourceType) {
            results.push({ "key": "sourceType", "field": "type", "value": sourceType, "group": "consent" });
        }

        /* test flag */
        if (typeof receipt.test !== "undefined") {
            results.push({ "key": "test", "field": "test", "value": String(receipt.test), "group": "consent" });
        }

        return results;
    }
}