import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.backgroundColor = UIColor(red: 0x23 / 255, green: 0x21 / 255, blue: 0x21 / 255, alpha: 1)
        window?.rootViewController = TypeRViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        open(connectionOptions.urlContexts)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
        open(URLContexts)
    }

    // The files the system asks the app to open: « Open in TypeR Studio » in Files, a share
    private func open(_ contexts: Set<UIOpenURLContext>) {
        for context in contexts where context.url.isFileURL {
            TypeRFilesPlugin.open(context.url, inPlace: context.options.openInPlace)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
