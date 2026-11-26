package one.jenix.lock;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import android.Manifest;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.net.Inet4Address;
import java.util.concurrent.TimeUnit;

/**
 * Small network helper for gateway setup and discovery.
 *
 * - wifiInfo(): the phone's IPv4 address/prefix on Wi-Fi, so the app knows
 *   which subnet to search for gateways.
 * - bindToWifi(): routes this app's traffic over Wi-Fi even when that Wi-Fi
 *   has no internet (the gateway's setup AP). Without it Android sends the
 *   requests to 192.168.4.1 over mobile data and they fail.
 * - unbind(): restores normal routing.
 * - setAlertConfig(): gateways + lock names for the background low-battery
 *   check (BatteryWorker, every ~15 min via WorkManager, also when closed).
 * - requestNotifications(), testNotification().
 */
@CapacitorPlugin(
    name = "JenixNet",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class JenixNetPlugin extends Plugin {

    private ConnectivityManager cm() {
        return (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    private Network wifiNetwork() {
        ConnectivityManager cm = cm();
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return n;
        }
        return null;
    }

    @PluginMethod
    public void wifiInfo(PluginCall call) {
        JSObject out = new JSObject();
        Network n = wifiNetwork();
        out.put("connected", n != null);
        if (n != null) {
            LinkProperties lp = cm().getLinkProperties(n);
            if (lp != null) {
                for (LinkAddress la : lp.getLinkAddresses()) {
                    if (la.getAddress() instanceof Inet4Address) {
                        out.put("ip", la.getAddress().getHostAddress());
                        out.put("prefixLength", la.getPrefixLength());
                        break;
                    }
                }
            }
        }
        call.resolve(out);
    }

    @PluginMethod
    public void bindToWifi(PluginCall call) {
        Network n = wifiNetwork();
        JSObject out = new JSObject();
        out.put("bound", n != null && cm().bindProcessToNetwork(n));
        call.resolve(out);
    }

    @PluginMethod
    public void unbind(PluginCall call) {
        cm().bindProcessToNetwork(null);
        call.resolve();
    }

    @PluginMethod
    public void setAlertConfig(PluginCall call) {
        JSObject cfg = call.getData();
        SharedPreferences sp = getContext().getSharedPreferences(BatteryWorker.PREFS, android.content.Context.MODE_PRIVATE);
        sp.edit().putString("config", cfg.toString()).apply();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(BatteryWorker.class, 15, TimeUnit.MINUTES).build();
        WorkManager.getInstance(getContext())
            .enqueueUniquePeriodicWork("battery-check", ExistingPeriodicWorkPolicy.KEEP, req);
        call.resolve();
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("granted", true);
            call.resolve(out);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsResult");
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(out);
    }

    @PluginMethod
    public void testNotification(PluginCall call) {
        BatteryWorker.notifyLow(getContext(), "test", call.getString("name", "Test lock"), call.getInt("battery", 20));
        call.resolve();
    }
}
