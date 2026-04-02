/**
 * Braze (enhanced)
 * https://www.braze.com/
 * https://www.braze.com/docs/developer_guide/platform_integration_guides/web/initial_sdk_setup/
 *
 * The existing Braze provider skeleton is upgraded here to:
 *  1. Detect the SDK library load (sdk.iad-XX.braze.com/api/v3/data)
 *  2. Decode POST body fields for /api/v3/data ingest requests
 *  3. Identify custom events, user attributes, and purchase events
 *  4. Surface the REST endpoint cluster (iad-01, iad-02, eu-01, etc.)
 *
 * Primary endpoints intercepted:
 *  - SDK data ingest : sdk.iad-XX.braze.com/api/v3/data  (POST, JSON)
 *  - SDK sessions    : sdk.iad-XX.braze.com/api/v3/sessions (POST, JSON)
 *  - SDK attributes  : sdk.iad-XX.braze.com/api/v3/attributes (POST)
 *  - SDK events      : sdk.iad-XX.braze.com/api/v3/events (POST)
 *  - SDK purchases   : sdk.iad-XX.braze.com/api/v3/purchases (POST)
 *  - Library load    : js.appboycdn.com/web-sdk/<version>/braze.min.js
 *
 * @class
 * @extends BaseProvider
 */
class BrazeProvider extends BaseProvider {
    constructor() {
        super();
        this._key      = "BRAZE";
        this._pattern  = /(?:sdk\.[a-z0-9-]+\.braze\.com\/api\/v\d+|js\.appboycdn\.com\/web-sdk)/;
        this._name     = "Braze";
        this._type     = "customer";
        this._keywords = [
            "crm", "push notification", "in-app message", "customer engagement",
            "lifecycle", "email", "sms", "appboy"
        ];
    }

    /**
     * Retrieve the column mappings for default columns (account, event type)
     *
     * @return {{}}
     */
    get columnMapping() {
        return {
            "account":     "api_key",
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
                "key":  "user",
                "name": "User Data"
            },
            {
                "key":  "events",
                "name": "Events"
            },
            {
                "key":  "purchases",
                "name": "Purchases"
            },
            {
                "key":  "attributes",
                "name": "User Attributes"
            }
        ];
    }

    /**
     * Get all of the available URL parameter keys (POST body fields, flattened)
     *
     * @returns {{}}
     */
    get keys() {
        return {
            "api_key": {
                "name":  "API Key",
                "group": "general"
            },
            "time": {
                "name":  "Request Timestamp",
                "group": "general"
            },
            "device_id": {
                "name":  "Device ID",
                "group": "user"
            },
            "sdk_version": {
                "name":  "SDK Version",
                "group": "general"
            },
            /* ---- events array fields (flattened via BaseProvider.parsePostData) ---- */
            "events[0].name": {
                "name":  "Event Name",
                "group": "events"
            },
            "events[0].time": {
                "name":  "Event Timestamp",
                "group": "events"
            },
            "events[0].external_id": {
                "name":  "User External ID",
                "group": "user"
            },
            /* ---- purchases array fields ---- */
            "purchases[0].product_id": {
                "name":  "Product ID",
                "group": "purchases"
            },
            "purchases[0].currency": {
                "name":  "Currency",
                "group": "purchases"
            },
            "purchases[0].price": {
                "name":  "Price",
                "group": "purchases"
            },
            "purchases[0].quantity": {
                "name":  "Quantity",
                "group": "purchases"
            },
            /* ---- attributes array fields ---- */
            "attributes[0].external_id": {
                "name":  "User External ID",
                "group": "user"
            },
            "attributes[0].email": {
                "name":  "Email",
                "group": "attributes"
            },
            "attributes[0].first_name": {
                "name":  "First Name",
                "group": "attributes"
            },
            "attributes[0].last_name": {
                "name":  "Last Name",
                "group": "attributes"
            },
            "attributes[0].country": {
                "name":  "Country",
                "group": "attributes"
            },
            "attributes[0].language": {
                "name":  "Language",
                "group": "attributes"
            },
            "attributes[0].home_city": {
                "name":  "Home City",
                "group": "attributes"
            }
        };
    }

    /**
     * Parse custom properties for a given URL
     *
     * @param    {string}   url
     * @param    {object}   params     Merged query + POST params
     *
     * @returns {void|Array}
     */
    handleCustom(url, params) {
        let results  = [];
        let hostname = url.hostname;
        let pathname = url.pathname;

        /* ---- Library load ---- */
        if (/js\.appboycdn\.com/i.test(hostname)) {
            const versionMatch = url.pathname.match(/web-sdk\/([\d.]+)/);
            if (versionMatch) {
                results.push({
                    "key":   "sdk_version",
                    "field": "SDK Version",
                    "value": versionMatch[1],
                    "group": "general"
                });
            }
            results.push({
                "key":   "requestTypeParsed",
                "field": "Request Type",
                "value": "Library Load",
                "group": "general"
            });
            return results;
        }

        /* ---- SDK data endpoint cluster ---- */
        const clusterMatch = hostname.match(/sdk\.([a-z0-9-]+)\.braze\.com/i);
        if (clusterMatch) {
            results.push({
                "key":   "cluster",
                "field": "SDK Cluster",
                "value": clusterMatch[1].toUpperCase(),
                "group": "general"
            });
        }

        /* ---- Classify endpoint by path ---- */
        let endpointMap = {
            "/api/v3/data":       "SDK Data Ingest",
            "/api/v3/sessions":   "Session Tracking",
            "/api/v3/attributes": "User Attributes",
            "/api/v3/events":     "Custom Event",
            "/api/v3/purchases":  "Purchase Event"
        };

        let matched = Object.entries(endpointMap).find(([path]) => pathname.startsWith(path));
        results.push({
            "key":   "requestTypeParsed",
            "field": "Request Type",
            "value": matched ? matched[1] : "SDK Request",
            "group": "general"
        });

        /* ---- Surface top-level event name from flattened POST params ---- */
        let eventName = params.get("events[0].name");
        if (eventName) {
            results.push({
                "key":   "primaryEventName",
                "field": "Primary Event Name",
                "value": eventName,
                "group": "events"
            });
        }

        /* ---- Surface top-level product from purchases ---- */
        let productId = params.get("purchases[0].product_id");
        if (productId) {
            results.push({
                "key":   "primaryProductId",
                "field": "Primary Product ID",
                "value": productId,
                "group": "purchases"
            });
        }

        return results;
    }
}
