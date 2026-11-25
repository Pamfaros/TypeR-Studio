package fr.scanr.typerstudio;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TypeRFilesPlugin.class);
        registerPlugin(TypeRLocalAIPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
