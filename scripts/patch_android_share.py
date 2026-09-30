from pathlib import Path
import re, shutil

root = Path(".")
src = root / "native/android/ShareReceiverPlugin.java"
dst = root / "android/app/src/main/java/com/obied/maintenance/ShareReceiverPlugin.java"
dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(src, dst)

main = root / "android/app/src/main/java/com/obied/maintenance/MainActivity.java"
content = main.read_text(encoding="utf-8")
if "ShareReceiverPlugin" not in content:
    content = content.replace(
        "import com.getcapacitor.BridgeActivity;",
        "import com.getcapacitor.BridgeActivity;\nimport com.obied.maintenance.ShareReceiverPlugin;",
        1
    )
    marker = "public class MainActivity extends BridgeActivity {"
    replacement = """public class MainActivity extends BridgeActivity {
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
    }"""
    if marker not in content:
        raise SystemExit("MainActivity class declaration not found")
    content = content.replace(marker, replacement, 1)
    main.write_text(content, encoding="utf-8")

manifest = root / "android/app/src/main/AndroidManifest.xml"
m = manifest.read_text(encoding="utf-8")
if "android.intent.action.SEND" not in m:
    block = re.search(r"<activity\b[\s\S]*?</activity>", m)
    if not block:
        raise SystemExit("Main activity not found in AndroidManifest.xml")
    filters = """        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="application/pdf" />
            <data android:mimeType="image/jpeg" />
            <data android:mimeType="image/png" />
            <data android:mimeType="image/webp" />
        </intent-filter>
"""
    activity = block.group(0)
    activity = activity.replace("</activity>", filters + "    </activity>", 1)
    m = m[:block.start()] + activity + m[block.end():]
    manifest.write_text(m, encoding="utf-8")

web = root / "www/index.html"
html = web.read_text(encoding="utf-8")
tag = '<script src="share-receiver.js"></script>'
if tag not in html:
    if "</body>" not in html:
        raise SystemExit("www/index.html has no closing body tag")
    html = html.replace("</body>", tag + "\n</body>", 1)
    web.write_text(html, encoding="utf-8")
shutil.copy2(root / "scripts/share-receiver.js", root / "www/share-receiver.js")
print("Android share receiver prepared successfully")
