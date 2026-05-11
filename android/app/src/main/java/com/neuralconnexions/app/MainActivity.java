package com.neuralconnexions.app;

import com.getcapacitor.BridgeActivity;
import com.neuralconnexions.app.plugins.NCImageSafetyMediaPipe;
import com.neuralconnexions.app.plugins.OnDeviceLLMPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NCImageSafetyMediaPipe.class);
        registerPlugin(OnDeviceLLMPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
