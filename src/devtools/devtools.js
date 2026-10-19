/*
 * Omnibug
 * Intermediary between eventPage and devTools panel
 * (used for message passing only)
 *
 */
(() => {
    /**
     * Create the panel
     */
    chrome.devtools.panels.create(
        "##OMNIBUG_NAME##",
        "../assets/images/blue-32.png",
        "../devtools/panel.html",
        (panel) => {
            console.log("devtools.panel.create", panel);
            let queuedMessages = [],
                panelWindow,  // reference to devtools_panel.html's `window` object
                port;

            const connectPort = () => {
                port = chrome.runtime.connect({
                    name: String(chrome.devtools.inspectedWindow.tabId)
                });

                port.onMessage.addListener((msg) => {
                    if (panelWindow) {
                        panelWindow.Omnibug.receive_message(msg);
                    } else {
                        queuedMessages.push(msg);
                    }
                });
                port.onDisconnect.addListener(() => {
                    port = null;
                    // Reconnecting throws if the extension was reloaded/unloaded
                    try {
                        connectPort();
                    } catch (e) {
                        console.warn("devtools: unable to reconnect port", e);
                    }
                });
            }
            connectPort();

            /**
             * Called when the devtools panel is first shown
             */
            const listener = (_window) => {
                panel.onShown.removeListener(listener); // Run once only
                panelWindow = _window;

                // Release queued messages
                let msg;
                while ((msg = queuedMessages.shift())) {
                    panelWindow.Omnibug.receive_message(msg);
                }

                // Inject a reply mechanism into the caller
                panelWindow.Omnibug.send_message = (...data) => {
                    // The port can be dead before onDisconnect fires, so reconnect and retry once
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            if (!port) {
                                connectPort();
                            }
                            port.postMessage(data);
                            return;
                        } catch (e) {
                            port = null;
                        }
                    }
                    console.warn("devtools: unable to send message, port unavailable");
                };
            };
            panel.onShown.addListener(listener);
        });

    return {};
})();
