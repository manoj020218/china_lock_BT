package one.jenix.lock;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JenixNetPlugin.class); // local plugin: gateway setup + discovery
        super.onCreate(savedInstanceState);
    }
}
