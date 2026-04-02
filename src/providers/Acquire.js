/**
 * Acquire.io
 * https://acquire.io/
 * https://developers.acquire.io/
 *
 * Acquire.io is a live chat / customer support platform with co-browsing,
 * video calling, and bot capabilities. Omnibug intercepts:
 *
 *  1. Library load    — acquire.io/bot/<accountId>/loader.js
 *                       cdn.acquire.io/widget/<accountId>/loader.js
 *  2. Session API     — app.acquire.io/api/v1/visitor/session (POST, JSON)
 *  3. Chat events     — app.acquire.io/api/v1/visitor/chat (POST, JSON)
 *  4. WebSocket init  — socket.acquire.io  (tracked as connection attempt)
 *
 * Key data points:
 *  - Account ID (from script URL path)
 *  - Visitor session token
 *  - Chat initiation events
 *  - Agent assignment
 *
 * @class
 * @extends BaseProvider
 */
class AcquireProvider extends BaseProvider {
    constructor() {
        super();
        this._key      = "ACQUIREIO";
        this._pattern  = /(?:acquire\.io\/(?:bot|widget)\/|app\.acquire\.io\/api\/v\d+\/visitor|socket\.acquire\.io)/;
        this._name     = "Acquire.io";
        this._type     = "customer";
        this._keywords = [
            "live chat", "livechat", "co-browse", "cobrowse",
            "customer support", "chat widget", "helpdesk"
        ];
    }

    /**
     * Retrieve the column mappings for default columns (account, event type)
     *
     * @return {{}}
     */
    get columnMapping() {
        return {
            "account":     "accountId",
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
                "key":  "visitor",
                "name": "Visitor"
            },
            {
                "key":  "chat",
                "name": "Chat"
            },
            {
                "key":  "agent",
                "name": "Agent"
            }
        ];
    }

    /**
     * Get all of the available URL parameter keys (POST body fields)
     *
     * @returns {{}}
     */
    get keys() {
        return {
            /* ---- Session / visitor params ---- */
            "account_id": {
                "name":  "Account ID",
                "group": "general"
            },
            "visitor_id": {
                "name":  "Visitor ID",
                "group": "visitor"
            },
            "session_id": {
                "name":  "Session ID",
                "group": "visitor"
            },
            "page_url": {
                "name":  "Current Page URL",
                "group": "visitor"
            },
            "referrer": {
                "name":  "Referrer",
                "group": "visitor"
            },
            "browser": {
                "name":  "Browser",
                "group": "visitor"
            },
            "os": {
                "name":  "Operating System",
                "group": "visitor"
            },
            "ip": {
                "name":  "IP Address",
                "group": "visitor"
            },
            "country": {
                "name":  "Country",
                "group": "visitor"
            },
            /* ---- Custom visitor attributes ---- */
            "name": {
                "name":  "Visitor Name",
                "group": "visitor"
            },
            "email": {
                "name":  "Visitor Email",
                "group": "visitor"
            },
            "phone": {
                "name":  "Visitor Phone",
                "group": "visitor"
            },
            /* ---- Chat params ---- */
            "message": {
                "name":  "Message",
                "group": "chat"
            },
            "chat_id": {
                "name":  "Chat ID",
                "group": "chat"
            },
            "type": {
                "name":  "Event Type",
                "group": "chat"
            },
            /* ---- Agent params ---- */
            "agent_id": {
                "name":  "Agent ID",
                "group": "agent"
            },
            "agent_name": {
                "name":  "Agent Name",
                "group": "agent"
            }
        };
    }

    /**
     * Parse custom properties for a given URL
     *
     * @param    {string}   url
     * @param    {object}   params
     *
     * @returns {void|Array}
     */
    handleCustom(url, params) {
        let results  = [];
        let hostname = url.hostname;
        let pathname = url.pathname;

        /* ---- Library / loader script ---- */
        const loaderMatch = pathname.match(/\/(?:bot|widget)\/([^/]+)\/loader\.js/i);
        if (loaderMatch) {
            results.push({
                "key":   "accountId",
                "field": "Account ID",
                "value": loaderMatch[1],
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

        /* ---- WebSocket init ---- */
        if (hostname === "socket.acquire.io") {
            results.push({
                "key":   "requestTypeParsed",
                "field": "Request Type",
                "value": "WebSocket Connection",
                "group": "general"
            });
            return results;
        }

        /* ---- REST API endpoints ---- */
        let endpointMap = {
            "/api/v1/visitor/session": "Visitor Session",
            "/api/v1/visitor/chat":    "Chat Initiation",
            "/api/v1/visitor/event":   "Visitor Event",
            "/api/v1/visitor/update":  "Visitor Update"
        };

        let matchedEndpoint = Object.entries(endpointMap).find(([path]) => pathname.startsWith(path));

        results.push({
            "key":   "requestTypeParsed",
            "field": "Request Type",
            "value": matchedEndpoint ? matchedEndpoint[1] : "API Request",
            "group": "general"
        });

        /* ---- Extract account_id from POST params if available ---- */
        let accountId = params.get("account_id");
        if (accountId) {
            results.push({
                "key":   "accountId",
                "field": "Account ID",
                "value": accountId,
                "group": "general"
            });
        }

        /* ---- Surface event type from POST body ---- */
        let eventType = params.get("type");
        if (eventType) {
            let eventLabels = {
                "message":  "Chat Message Sent",
                "join":     "Chat Joined",
                "leave":    "Chat Left",
                "transfer": "Chat Transferred",
                "close":    "Chat Closed",
                "typing":   "Visitor Typing"
            };
            results.push({
                "key":   "eventTypeParsed",
                "field": "Event Type",
                "value": eventLabels[eventType] || eventType,
                "group": "chat"
            });
        }

        return results;
    }
}
