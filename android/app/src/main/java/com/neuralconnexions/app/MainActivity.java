package com.neuralconnexions.app;

import com.getcapacitor.BridgeActivity;
import com.neuralconnexions.app.plugins.NCImageSafetyMediaPipe;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NCImageSafetyMediaPipe.class);
        super.onCreate(savedInstanceState);
    }
}
