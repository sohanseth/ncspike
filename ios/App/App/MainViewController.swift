//
//  MainViewController.swift
//  NeuralConnexions: the app's web view, with the app's own native plugins registered.
//
//  Capacitor 8 finds plugins that come from npm packages by itself, but not the ones written inside the app:
//  each must be registered here, and its file must be in the App target. Main.storyboard uses this class
//  (customClass="MainViewController", customModule="App").
//
//  NCImageSafetyVision (the image check) isn't registered yet: its file has never been in the App target or
//  built, and the MVP doesn't need it. It keeps using its in-app fallback until it's checked.
//

import Capacitor
import UIKit

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(FoundItemsPlugin())
        bridge?.registerPluginInstance(LetterTextPlugin())
        bridge?.registerPluginInstance(SharedInboxPlugin())
        bridge?.registerPluginInstance(OnDeviceLLMPlugin())
    }
}
