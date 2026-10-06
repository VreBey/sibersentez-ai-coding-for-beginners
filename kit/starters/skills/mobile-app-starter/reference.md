# Mobile app starter: reference

Run commands from the app folder (for example `mobile/`).

## What the default template creates

```
mobile/
  src/
    app/            screens; the folder structure is the navigation
      _layout.tsx   the frame around every screen
      index.tsx     the home screen
      explore.tsx   a second screen
    components/     reusable pieces
  assets/           images and fonts
  app.json          app name, icon, version, bundle identifiers
  package.json
```

The layout changes between Expo SDK versions: older templates keep the screens in a top-level `app/` folder with a
`(tabs)/` subfolder. List the folders after creating the app and use what is really there.

Some templates also write notes for AI coding tools (`AGENTS.md`). Leave them in place.

## Verification commands

| Check | Command |
|---|---|
| Start the dev server | `npx expo start` |
| Start and clear the cache | `npx expo start --clear` |
| Project health | `npx expo-doctor` |
| Types | `npx tsc --noEmit` |
| Fix package versions to match the SDK | `npx expo install --fix` (changes versions: ask first) |

## Common problems

| Message or symptom | Cause and fix |
|---|---|
| The phone cannot reach the dev server, or loads forever | Phone and computer on different networks, a VPN, or the firewall blocked Node.js. Use the same Wi-Fi, pause the VPN, allow Node.js on private networks. If it still fails: `npx expo start --tunnel` (it may offer to install a helper package: ask). |
| "Project is incompatible with this version of Expo Go" | The project's Expo SDK and the Expo Go app do not match. Update Expo Go from the store; if the project is older, upgrade the project's SDK (a separate, careful step) or use a development build. |
| `Unable to resolve module ...` | The package is not installed, or the cache is old. `npx expo install <package>`, then `npx expo start --clear`. |
| "Text strings must be rendered within a `<Text>` component" | Plain text placed directly inside a `View`. Wrap it in `<Text>`. |
| Changes do not show up | File not saved, or the app lost its connection. Save, press `r` in the terminal, or restart with `--clear`. |
| "The following packages should be updated for best compatibility" | Versions drifted from the SDK. `npx expo install --fix` after a yes. |
| `npm.ps1 cannot be loaded because running scripts is disabled` | PowerShell policy. Use `npx.cmd`, or Command Prompt. Changing the policy needs the user's yes. |
| Red screen with a long error | Read the first lines: they name the file and line. Fix that, then reload. |
| Android emulator: `adb` not found | Android Studio and its SDK platform tools are not installed or not on PATH. An emulator is optional; a real phone with Expo Go is enough to start. |
| Odd build errors mentioning the path | Spaces or non-English letters in the path. Move the project to a short path such as `C:\dev\my-app` (ask first). |

## Good habits

- Test on the phone the users will have (small screen, Android and iPhone if both matter).
- Ask for phone permissions (camera, location, notifications) only when the feature needs them, with a short reason.
- Keep app texts in one place from the start if the app may be translated later.

## Moving between screens (Expo Router)

The folder structure is the navigation:

```
src/app/             (or app/ in older templates)
  _layout.tsx        the frame: a stack of screens
  index.tsx          the home screen, address /
  about.tsx          address /about
  note/[id].tsx      address /note/5, receives id = "5"
```

`src/app/_layout.tsx` (a stack with a header):

```tsx
import { Stack } from 'expo-router';

export default function Layout() {
  return <Stack />;
}
```

A link and a button that navigate (`src/app/index.tsx`):

```tsx
import { Link, router } from 'expo-router';
import { Button, Text, View } from 'react-native';

export default function Home() {
  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text>Home</Text>
      <Link href="/about">Go to About</Link>
      <Button title="Open note 5" onPress={() => router.push('/note/5')} />
    </View>
  );
}
```

Reading the parameter (`src/app/note/[id].tsx`): `const { id } = useLocalSearchParams<{ id: string }>();` with the import
from `expo-router`. Bottom tabs: put the screens in a `(tabs)/` folder inside the app folder with a `_layout.tsx` that returns `<Tabs />` from
`expo-router`; check whether the template already does this. The back button and the swipe back come with the stack.

## Keeping data on the phone

| Need | Use | Install |
|---|---|---|
| A few settings, a short list | AsyncStorage | `npx expo install @react-native-async-storage/async-storage` |
| Many records to search | SQLite | `npx expo install expo-sqlite` |
| A token or anything private | secure storage | `npx expo install expo-secure-store` |

AsyncStorage keeps text, so lists are saved as JSON:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';

export async function saveNotes(notes: string[]) {
  await AsyncStorage.setItem('notes', JSON.stringify(notes));
}

export async function loadNotes(): Promise<string[]> {
  const text = await AsyncStorage.getItem('notes');
  return text ? JSON.parse(text) : [];
}
```

Call `loadNotes` once when the screen opens (`useEffect`) and `saveNotes` after every change. Data stays on that phone:
it is lost when the app is uninstalled and is never shared with other phones. Do not keep passwords here.

## Permissions

Expo modules ask the person at the moment you request. Example with the camera
(`npx expo install expo-camera`):

```tsx
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, Text, View } from 'react-native';

export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  if (!permission) return <View />;
  if (!permission.granted) {
    return (
      <View style={{ padding: 24 }}>
        <Text>The camera is used to scan the code on the package.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
      </View>
    );
  }
  return <CameraView style={{ flex: 1 }} />;
}
```

Ask only when the feature opens, explain why in the screen's own words, and handle "no". Many modules add their
permission text through a plugin entry in `app.json`; the module's documentation shows the exact keys. iPhones show
that text to people, so write it in plain words in the app's language.

## Publishing with EAS

Official guide: https://docs.expo.dev/build/introduction/ (commands and options change; read it first).

1. In `app.json` set `name`, `slug`, `version`, `android.package` and `ios.bundleIdentifier` (a reverse address you own,
   for example `com.yourname.notes`; it cannot change after publishing), the icon and the splash image.
2. The user makes a free Expo account. `npx eas-cli@latest login` (they type the password themselves).
3. `npx eas-cli@latest build:configure` writes `eas.json`.
4. A test build for Android: `npx eas-cli@latest build --platform android --profile preview` makes an installable file
   in the cloud; the user opens the link it prints on their phone. The queue can take a while on the free plan.
5. iPhone builds and the App Store need an Apple Developer Program account (paid yearly); Google Play needs a
   developer account (paid once). Check the current prices and rules on those sites.
6. Store builds use the production profile; `eas submit` can upload them. Stores review the app: have a privacy text,
   screenshots and a short description ready; each permission must be explained.
7. Raise `version` for every release. Small fixes that only change the app's own code can be sent as an update
   (`eas update`) without a new store review; check the documentation for what it may change.

## Common problems (publishing and data)

| Message or symptom | Cause and fix |
|---|---|
| A project id error in EAS commands | the project was not linked: run `npx eas-cli@latest init` after logging in. |
| The build fails in the cloud but the app runs in Expo Go | a native module or a version mismatch. Run `npx expo-doctor` and read the first red line of the build log. |
| The data is empty after a restart | it was kept in a variable, not saved; or the key name differs between save and load. |
| The permission dialog never shows again | the person said no twice; the app can only point them to the phone's settings. |
| The package name is already taken | choose another `android.package`; it must be unique among all apps. |
