import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Register local Swift Capacitor plugins as soon as the bridge
        // view controller finishes loading. The bridge isn't available
        // synchronously from `application(_:didFinishLaunching...)`,
        // so we observe Capacitor's `capacitorViewDidLoad` notification
        // and call `registerPluginInstance` on the bridge it carries.
        NotificationCenter.default.addObserver(
            forName: Notification.Name.capacitorViewDidLoad,
            object: nil,
            queue: .main
        ) { notification in
            guard let bridge = notification.object as? CAPBridgeProtocol else { return }
            bridge.registerPluginInstance(NCImageSafetyVision())
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        return ApplicationDelegateProxy.shared.application(
            application,
            continue: userActivity,
            restorationHandler: restorationHandler
        )
    }
}
