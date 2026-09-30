package com.obied.maintenance;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.UUID;

@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {
    private static Intent pendingIntent;

    public static synchronized void captureIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action)) return;
        Uri uri = null;
        try {
            Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) uri = (Uri) extra;
        } catch (Exception ignored) {}
        if (uri == null) return;
        pendingIntent = intent;
    }

    @PluginMethod
    public synchronized void getSharedFile(PluginCall call) {
        Intent intent = pendingIntent;
        if (intent == null) {
            call.resolve(new JSObject().put("available", false));
            return;
        }

        Uri uri = null;
        try {
            Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) uri = (Uri) extra;
        } catch (Exception ignored) {}

        if (uri == null) {
            pendingIntent = null;
            call.resolve(new JSObject().put("available", false));
            return;
        }

        try {
            Context context = getContext();
            String mime = intent.getType();
            if (mime == null || mime.trim().isEmpty()) {
                mime = context.getContentResolver().getType(uri);
            }
            if (mime == null) mime = "application/octet-stream";

            String displayName = queryDisplayName(uri);
            if (displayName == null || displayName.trim().isEmpty()) {
                String ext = mime.contains("pdf") ? ".pdf" : (mime.startsWith("image/") ? ".jpg" : ".bin");
                displayName = "payment-proof-" + System.currentTimeMillis() + ext;
            }

            File dir = new File(context.getFilesDir(), "shared_receipts");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("تعذر إنشاء مجلد إثبات الدفع");

            File out = new File(dir, UUID.randomUUID().toString() + "-" + sanitize(displayName));
            long size = 0;

            try (InputStream in = context.getContentResolver().openInputStream(uri);
                 FileOutputStream fos = new FileOutputStream(out)) {
                if (in == null) throw new Exception("تعذر قراءة الملف المرسل من تطبيق البنك");
                byte[] buffer = new byte[1024 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) {
                    fos.write(buffer, 0, n);
                    size += n;
                }
            }

            pendingIntent = null;

            JSObject ret = new JSObject();
            ret.put("available", true);
            ret.put("uri", Uri.fromFile(out).toString());
            ret.put("fileName", displayName);
            ret.put("mimeType", mime);
            ret.put("size", size);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("تعذر استلام ملف إثبات الدفع: " + e.getMessage());
        }
    }

    @PluginMethod
    public synchronized void deleteSharedFile(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.resolve();
            return;
        }
        try {
            Uri uri = Uri.parse(uriString);
            if ("file".equalsIgnoreCase(uri.getScheme())) {
                File f = new File(uri.getPath());
                if (f.exists()) f.delete();
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    private String queryDisplayName(Uri uri) {
        Cursor c = null;
        try {
            c = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    private String sanitize(String name) {
        return name.replaceAll("[\\/:*?"<>|]", "_");
    }
}
