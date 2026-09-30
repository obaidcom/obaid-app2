from pathlib import Path
import re
import shutil

root = Path(".")
plugin_src = root / "native/android/ShareReceiverPlugin.java"
plugin_dst = root / "android/app/src/main/java/com/obied/maintenance/ShareReceiverPlugin.java"
plugin_dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(plugin_src, plugin_dst)

main = root / "android/app/src/main/java/com/obied/maintenance/MainActivity.java"
content = main.read_text(encoding="utf-8")
if "ShareReceiverPlugin" not in content:
    content = content.replace(
        "import com.getcapacitor.BridgeActivity;",
        "import com.getcapacitor.BridgeActivity;\nimport com.obied.maintenance.ShareReceiverPlugin;",
        1,
    )
    content = content.replace(
        "public class MainActivity extends BridgeActivity {",
        """public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ShareReceiverPlugin.class);
        ShareReceiverPlugin.captureIntent(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        ShareReceiverPlugin.captureIntent(intent);
    }""",
        1,
    )
main.write_text(content, encoding="utf-8")

manifest = root / "android/app/src/main/AndroidManifest.xml"
m = manifest.read_text(encoding="utf-8")
if "android.intent.action.SEND" not in m:
    match = re.search(r"<activity\b[\s\S]*?</activity>", m)
    if not match:
        raise SystemExit("Main activity not found")
    block = match.group(0)
    filters = """
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="application/pdf" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="image/jpeg" />
            <data android:mimeType="image/png" />
            <data android:mimeType="image/webp" />
        </intent-filter>
"""
    m = m.replace("</activity>", filters + "        </activity>", 1)
manifest.write_text(m, encoding="utf-8")

web = root / "www/index.html"
html = web.read_text(encoding="utf-8")
tag = '<script src="share-receiver.js"></script>'
if tag not in html:
    html = html.replace("</body>", tag + "\n</body>", 1)
web.write_text(html, encoding="utf-8")
shutil.copy2(root / "scripts/share-receiver.js", root / "www/share-receiver.js")
print("Android share receiver patched successfully")
