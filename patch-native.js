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
