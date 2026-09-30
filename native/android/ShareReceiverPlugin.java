package com.obied.maintenance;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {
    private static Intent pendingIntent;

    public static synchronized void captureIntent(Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_SEND.equals(intent.getAction()) && intent.getParcelableExtra(Intent.EXTRA_STREAM) != null) {
            pendingIntent = new Intent(intent);
        }
    }

    @PluginMethod
    public synchronized void getSharedFile(PluginCall call) {
        Intent intent = pendingIntent;
        if (intent == null) {
            JSObject ret = new JSObject();
            ret.put("available", false);
            call.resolve(ret);
            return;
        }

        Uri source = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (source == null) {
            pendingIntent = null;
            call.resolve(new JSObject());
            return;
        }

        try {
            String mime = intent.getType();
            if (mime == null || mime.isEmpty()) mime = getContext().getContentResolver().getType(source);
            if (mime == null) mime = "application/octet-stream";

            String displayName = queryDisplayName(source);
            if (displayName == null || displayName.trim().isEmpty()) {
                displayName = "payment-proof";
            }
            displayName = sanitize(displayName);

            File dir = new File(getContext().getFilesDir(), "shared_receipts");
            if (!dir.exists() && !dir.mkdirs()) {
                throw new Exception("تعذر إنشاء مجلد الملف المستلم");
            }

            File out = new File(dir, System.currentTimeMillis() + "_" + displayName);
            long size = 0;

            try (InputStream in = getContext().getContentResolver().openInputStream(source);
                 FileOutputStream fos = new FileOutputStream(out)) {
                if (in == null) throw new Exception("تعذر فتح الملف المستلم");
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
                File file = new File(uri.getPath());
                if (file.exists()) file.delete();
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    private String queryDisplayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContext().getContentResolver().query(
                uri,
                new String[]{OpenableColumns.DISPLAY_NAME},
                null, null, null
            );
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    private String sanitize(String name) {
        return name.replaceAll("[^a-zA-Z0-9._-]", "_");
    }
}
