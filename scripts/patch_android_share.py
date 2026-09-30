from pathlib import Path
import re, shutil

root=Path(".")
src=root/"native/android/ShareReceiverPlugin.java"
dst=root/"android/app/src/main/java/com/obied/maintenance/ShareReceiverPlugin.java"
dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,dst)

main=root/"android/app/src/main/java/com/obied/maintenance/MainActivity.java"
s=main.read_text(encoding="utf-8")
if "ShareReceiverPlugin" not in s:
    s=s.replace("import com.getcapacitor.BridgeActivity;","import com.getcapacitor.BridgeActivity;\nimport com.obied.maintenance.ShareReceiverPlugin;",1)
    marker="public class MainActivity extends BridgeActivity {"
    repl="""public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(ShareReceiverPlugin.class);
        ShareReceiverPlugin.captureIntent(getIntent());
        super.onCreate(savedInstanceState);
    }
    @Override public void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        ShareReceiverPlugin.captureIntent(intent);
    }"""
    if marker not in s: raise SystemExit("MainActivity declaration not found")
    s=s.replace(marker,repl,1); main.write_text(s,encoding="utf-8")

manifest=root/"android/app/src/main/AndroidManifest.xml"
m=manifest.read_text(encoding="utf-8")
if "android.intent.action.SEND" not in m:
    block=re.search(r"<activity\b[\s\S]*?</activity>",m)
    if not block: raise SystemExit("MainActivity not found")
    filt='''        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="application/pdf" />
            <data android:mimeType="image/jpeg" />
            <data android:mimeType="image/png" />
            <data android:mimeType="image/webp" />
        </intent-filter>
'''
    a=block.group(0).replace("</activity>",filt+"    </activity>",1)
    m=m[:block.start()]+a+m[block.end():]
    manifest.write_text(m,encoding="utf-8")

web=root/"www/index.html"
h=web.read_text(encoding="utf-8")
tag='<script src="share-receiver.js"></script>'
if tag not in h:
    h=h.replace("</body>",tag+"\n</body>",1); web.write_text(h,encoding="utf-8")
shutil.copy2(root/"scripts/share-receiver.js",root/"www/share-receiver.js")
print("share receiver patched safely")
