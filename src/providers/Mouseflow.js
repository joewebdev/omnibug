/**
 * Mouseflow
 * https://mouseflow.com/
 * https://help.mouseflow.com/en/articles/6896058-mouseflow-tracking-code
 *
 * Mouseflow is a session replay and heatmap tool. It fires two main
 * request types that Omnibug can intercept:
 *
 *  1. Library load  — cdn.mouseflow.com/projects/<websiteId>.js
 *  2. Recording API — mouseflow.com/api/session/start  (POST, JSON body)
 *
 * @class
 * @extends BaseProvider
 */
class MouseflowProvider extends BaseProvider {
    constructor() {
        super();
        this._key      = "MOUSEFLOW";
        this._pattern  = /(?:cdn\.mouseflow\.com\/projects\/[0-9a-f-]+\.js|mouseflow\.com\/api\/session)/;
        this._name     = "Mouseflow";
        this._type     = "replay";
        this._keywords = ["session replay", "heatmap", "heat map", "session record", "click map"];
    }

    /**
     * Retrieve the column mappings for default columns (account, event type)
     *
     * @return {{}}
     */
    get columnMapping() {
        return {
            "account":     "websiteId",
            "requestType": "requestTypeParsed"
        };
    }

    /**
     * Retrieve the group names & order
     *
     * @returns {*[]}
     */
    get groups() {
        return [
            {
                "key":  "general",
                "name": "General"
            },
            {
                "key":  "session",
                "name": "Session"
            },
            {
                "key":  "recording",
                "name": "Recording Settings"
            }
        ];
    }

    /**
     * Get all of the available URL parameter keys
     * Used primarily for the session/start API endpoint.
     *
     * @returns {{}}
     */
    get keys() {
        return {
            /* ---- Session start POST body params ---- */
            "websiteId": {
                "name":  "Website ID",
                "group": "general"
            },
            "sessionId": {
                "name":  "Session ID",
                "group": "session"
            },
            "pageviewId": {
                "name":  "Pageview ID",
                "group": "session"
            },
            "url": {
                "name":  "Recorded Page URL",
                "group": "general"
            },
            "referrer": {
                "name":  "Referrer",
                "group": "general"
            },
            "language": {
                "name":  "Browser Language",
                "group": "session"
            },
            "screenWidth": {
                "name":  "Screen Width",
                "group": "session"
            },
            "screenHeight": {
                "name":  "Screen Height",
                "group": "session"
            },
            "windowWidth": {
                "name":  "Window Width",
                "group": "session"
            },
            "windowHeight": {
                "name":  "Window Height",
                "group": "session"
            },
            "devicePixelRatio": {
                "name":  "Device Pixel Ratio",
                "group": "session"
            },
            "samplingRate": {
                "name":  "Sampling Rate",
                "group": "recording"
            },
            "recordingRate": {
                "name":  "Recording Rate",
                "group": "recording"
            },
            "gdpr": {
                "name":  "GDPR Mode",
                "group": "recording"
            },
            "keyLogging": {
                "name":  "Key Logging",
                "group": "recording"
            },
            "mousemoveOnly": {
                "name":  "Mousemove Only",
                "group": "recording"
            },
            "mouseflowVersion": {
                "name":  "Library Version",
                "group": "general"
            }
        };
    }

    /**
     * Parse custom properties for a given URL
     *
     * Handles both the library load request (cdn.mouseflow.com/projects/<id>.js)
     * and the session API request (mouseflow.com/api/session/start).
     *
     * @param    {string}   url
     * @param    {object}   params
     *
     * @returns {void|Array}
     */
    handleCustom(url, params) {
        let results = [];

        /* ---- Library load: extract website ID from URL path ---- */
        const libraryMatch = url.pathname.match(/\/projects\/([0-9a-f-]+)\.js/i);
        if (libraryMatch) {
            results.push({
                "key":   "websiteId",
                "field": "Website ID",
                "value": libraryMatch[1],
                "group": "general"
            });
            results.push({
                "key":   "requestTypeParsed",
                "field": "Request Type",
                "value": "Library Load",
                "group": "general"
            });
            return results;
        }

        /* ---- Session API: classify the endpoint ---- */
        const apiMatch = url.pathname.match(/\/api\/session\/?([\w-]*)/i);
        if (apiMatch) {
            let endpoint = apiMatch[1] || "start";
            let requestTypeMap = {
                "start":    "Session Start",
                "update":   "Session Update",
                "complete": "Session Complete",
                "event":    "Custom Event"
            };

            results.push({
                "key":   "requestTypeParsed",
                "field": "Request Type",
                "value": requestTypeMap[endpoint] || "Session API",
                "group": "general"
            });

            /* Pull websiteId from POST body (already merged into params) */
            if (!params.get("websiteId") && !params.get("website_id")) {
                results.push({
                    "key":   "websiteId",
                    "field": "Website ID",
                    "value": "(see POST body)",
                    "group": "general"
                });
            }
        }

        return results;
    }
}
