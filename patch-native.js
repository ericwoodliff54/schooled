// Adds the camera and photo permissions the Fish Check needs to the native projects. Safe to run more than once. Run after "npx cap sync".
const fs = require('fs');
const path = require('path');
const root = __dirname;
const man = path.join(root, 'android/app/src/main/AndroidManifest.xml');
if (fs.existsSync(man)) {
  let x = fs.readFileSync(man, 'utf8');
  ['android.permission.CAMERA', 'android.permission.INTERNET'].forEach((p) => {
    if (!x.includes(p)) x = x.replace('</manifest>', '    <uses-permission android:name="' + p + '" />\n</manifest>');
  });
  // Reminders do not need exact alarms, and Play asks for a special declaration if the app asks for them.
  if (!x.includes('xmlns:tools')) x = x.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
  if (!x.includes('SCHEDULE_EXACT_ALARM')) x = x.replace('</manifest>', '    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" tools:node="remove" />\n</manifest>');
  if (!x.includes('android.hardware.camera')) x = x.replace('</manifest>', '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>');
  fs.writeFileSync(man, x);
  console.log('patched AndroidManifest.xml');
}
const plist = path.join(root, 'ios/App/App/Info.plist');
if (fs.existsSync(plist)) {
  let x = fs.readFileSync(plist, 'utf8');
  const add = {
    NSCameraUsageDescription: 'Schooled uses the camera to photograph your fish, corals and test strips.',
    NSPhotoLibraryUsageDescription: 'Schooled reads photos you pick so it can identify fish and read test strips.',
    NSPhotoLibraryAddUsageDescription: 'Schooled can save tank pictures you create to your photos.'
  };
  Object.keys(add).forEach((k) => { if (!x.includes('<key>' + k + '</key>')) x = x.replace('</dict>\n</plist>', '\t<key>' + k + '</key>\n\t<string>' + add[k] + '</string>\n</dict>\n</plist>'); });
  fs.writeFileSync(plist, x);
  console.log('patched Info.plist');
}

// Release signing and version numbers, only when the release workflow asks for them (it sets these environment variables).
const gradle = path.join(root, 'android/app/build.gradle');
if (fs.existsSync(gradle) && (process.env.KEYSTORE_FILE || process.env.VERSION_CODE)) {
  let g = fs.readFileSync(gradle, 'utf8');
  if (process.env.VERSION_CODE) g = g.replace(/versionCode \d+/, 'versionCode ' + parseInt(process.env.VERSION_CODE, 10));
  if (process.env.VERSION_NAME) g = g.replace(/versionName "[^"]*"/, 'versionName "' + process.env.VERSION_NAME.replace(/[^0-9A-Za-z.\-]/g, '') + '"');
  if (process.env.KEYSTORE_FILE && !g.includes('signingConfigs')) {
    g = g.replace('    buildTypes {', `    signingConfigs {
        release {
            storeFile file(System.getenv('KEYSTORE_FILE'))
            storePassword System.getenv('KEYSTORE_PASSWORD')
            keyAlias System.getenv('KEY_ALIAS')
            keyPassword System.getenv('KEY_PASSWORD')
        }
    }
    buildTypes {`);
    g = g.replace("        release {\n            minifyEnabled false", "        release {\n            signingConfig signingConfigs.release\n            minifyEnabled false");
  }
  if (process.env.KEYSTORE_FILE && !g.includes('signingConfig signingConfigs.release')) throw new Error('Signing setup was not applied to build.gradle. The Capacitor template may have changed.');
  fs.writeFileSync(gradle, g);
  console.log('patched build.gradle for release');
}
