package one.jenix.lock;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Background low-battery check (WorkManager, ~every 15 min, also when the app
 * is closed). Asks each saved gateway for GET /api/alerts (the gateway itself
 * measures every lock's battery a few times a day) and posts a notification
 * with sound + vibration for any lock below the threshold — at most once per
 * lock per 24 h. Works while the phone is on the same Wi-Fi as the gateway.
 */
public class BatteryWorker extends Worker {
    static final String PREFS = "jenix_alerts";
    static final String CHANNEL = "battery_low";
    private static final long REPEAT_MS = 24L * 3600 * 1000;

    public BatteryWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONObject cfg = new JSONObject(sp.getString("config", "{}"));
            JSONArray gws = cfg.optJSONArray("gateways");
            JSONObject names = cfg.optJSONObject("lockNames");
            if (gws == null) return Result.success();
            for (int i = 0; i < gws.length(); i++) {
                JSONObject gw = gws.getJSONObject(i);
                JSONObject res = get("http://" + gw.getString("host") + "/api/alerts", gw.getString("token"));
                if (res == null) continue;
                JSONArray locks = res.optJSONArray("locks");
                if (locks == null) continue;
                for (int j = 0; j < locks.length(); j++) {
                    JSONObject l = locks.getJSONObject(j);
                    if (!l.optBoolean("low")) continue;
                    String id = l.getString("lock_id");
                    String key = "notified_" + id;
                    long now = System.currentTimeMillis();
                    if (now - sp.getLong(key, 0) < REPEAT_MS) continue;
                    String name = names != null ? names.optString(id, id) : id;
                    notifyLow(ctx, id, name, l.optInt("battery", -1));
                    sp.edit().putLong(key, now).apply();
                }
            }
        } catch (Exception e) {
            // Off the home Wi-Fi or gateway asleep: try again next run.
        }
        return Result.success();
    }

    private static JSONObject get(String url, String token) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(8000);
            c.setRequestProperty("Authorization", "Bearer " + token);
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return new JSONObject(sb.toString());
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Lock battery low", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Alerts when a lock's battery drops below 25%");
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[] {0, 400, 200, 400, 200, 600});
        ch.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()
        );
        nm.createNotificationChannel(ch);
    }

    static void notifyLow(Context ctx, String lockId, String name, int pct) {
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, lockId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String level = pct >= 0 ? pct + "%" : "low";
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setContentTitle("🔋 " + name + ": battery " + level)
            .setContentText("Replace the lock batteries soon so it keeps working.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setVibrate(new long[] {0, 400, 200, 400, 200, 600})
            .setAutoCancel(true)
            .setContentIntent(pi);
        NotificationManagerCompat.from(ctx).notify(lockId.hashCode(), b.build());
    }
}
