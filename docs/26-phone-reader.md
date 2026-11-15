# docs/26 — The message reader on the iPhone (phone-first MVP, week 2)

Decided on 15 Nov 2026: the MVP is the phone app alone, for parents without a computer. A parent shares a message
(a school email, a class WhatsApp message, a club text, a photo of a letter) and the phone finds what it asks of
them: dates, deadlines, days off, what to bring. Nothing leaves the phone.

## What's in the code

- `src/lib/reader/family-engine.ts`: the reader. Rules that work everywhere, and Apple's on-device model on top
  where the iPhone has it, with every proposal checked against the message (dates worked out by code, the quote must
  be in the message, a child named only if the message names them, what to bring in the message's own words). It
  gives the same answers as the Mac app's `nc/app/family.py` (`tests/reader/fixtures/parity.json`).
- `src/lib/reader/phone-reader.ts`: the native plugins, with safe fallbacks (on the web, the rules alone).
- `src/lib/reader/reader-check.ts` and `reader-check-messages.ts`: *Check the reader*, 17 made-up messages with
  known answers, read on the phone with the rules alone and with Apple's model. Its result holds only numbers and
  the made-up messages' names, so it can be shared. Don't tune the reader on these messages: they're how Apple's
  model is measured. On 15 Nov 2026 the rules alone found 17 of 24 (13 well named, 3 unwanted).
- `src/routes/workspace.reader.tsx`: the *Message reader* page (`/workspace/reader`), in the iPhone app's More menu.
- `ios/App/App/MainViewController.swift` registers the app's own plugins: `FoundItems` (Apple's model),
  `LetterText` (a photo's words, with Apple's Vision), `SharedInbox` (what other apps shared) and `OnDeviceLLM`
  (PRIVATE chat, fixed for iOS 26). `NCImageSafetyVision` isn't registered yet: it has never been built.
- `ios/share-extension/`: the Share button's extension, added in Xcode as below.
- `ios/App/App/Info.plist`: the camera, photos, microphone and speech purpose strings the app was missing.

The iPhone app loads the published site, so changes to the web code reach the phone after **Publish → Update** in
Lovable. Changes under `ios/` need a new build in Xcode.

## In Xcode, once

Get the code onto the Mac (`git pull`, or a fresh clone), then in its folder run `npm install`, `npx cap sync ios`
and `npx cap open ios`.

1. **App Group for the app:** select the *App* target → *Signing & Capabilities* → *+ Capability* → *App Groups* →
   *+* → `group.com.neuralconnexions.shared`.
2. **The Share button:** *File → New → Target… → Share Extension*, named `NCShare`, then *Finish* (and *Activate*
   if asked). In the *NCShare* target:
   - *General*: Display Name `NeuralConnexions` (it's what the share sheet shows), Minimum Deployments iOS 15.0.
   - *Signing & Capabilities*: your team, and *+ Capability → App Groups* with the same group, ticked.
   - In Terminal, in the code's folder: `cp ios/share-extension/ShareViewController.swift ios/App/NCShare/ShareViewController.swift`
   - Open `NCShare/Info.plist` in Xcode (right-click → *Open As → Source Code*) and replace its `NSExtension` entry
     with the one in `ios/share-extension/NSExtension.plist.xml`.
3. **Run it** on the iPhone (choose the *App* scheme and the phone, then ▶). In the app: More → *Message reader* →
   *Run the check*, then *Copy the result*. Try the Share button from WhatsApp or Photos too.
4. **Save the Xcode changes:** commit and push what Xcode added (the NCShare folder, the project file and the
   entitlements), so the next build has them.

## TestFlight

1. In App Store Connect: *Apps → + → New App* (iOS, bundle ID `com.neuralconnexions.app`).
2. In Xcode: choose *Any iOS Device*, raise the build number, then *Product → Archive → Distribute App → App Store
   Connect*.
3. In App Store Connect → *TestFlight*: test it yourself first (internal testing). For the first mothers (external
   testing), Apple reviews the first build and asks for a short description, a feedback email and a privacy notice.
