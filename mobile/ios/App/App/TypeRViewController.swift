import Capacitor
import UIKit

// The window of the app: Capacitor's own, with what TypeR Studio adds to it.
class TypeRViewController: CAPBridgeViewController {
    // The page's address is the desktop app's, typer://app: what the page keeps (settings,
    // styles, pages left open) is tied to it, so it must never change once the app is out.
    // Android has its own in capacitor.config.json: a web view there only serves https.
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        descriptor.urlScheme = "typer"
        descriptor.urlHostname = "app"
        return descriptor
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TypeRFilesPlugin())
        bridge?.registerPluginInstance(TypeRChromePlugin())
        // The page is an app, not a document: it doesn't rubber-band, and it has no link previews
        webView?.scrollView.bounces = false
        webView?.scrollView.alwaysBounceVertical = false
        webView?.allowsLinkPreview = false
    }
}
