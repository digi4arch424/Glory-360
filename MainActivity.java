package com.yourname.glory360;

import android.app.Activity;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {

    private WebView webView;

    // ── Android Download Bridge ──────────────────────────────────
    // This class is injected into the WebView as "AndroidBridge".
    // JavaScript calls AndroidBridge.saveFile(filename, content)
    // and the file is written directly to the Downloads folder.
    public class DownloadBridge {

        @JavascriptInterface
        public void saveFile(String filename, String content) {
            try {
                // Write to public Downloads folder
                File downloadsDir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS);

                if (!downloadsDir.exists()) {
                    downloadsDir.mkdirs();
                }

                File outFile = new File(downloadsDir, filename);
                OutputStreamWriter writer = new OutputStreamWriter(
                        new FileOutputStream(outFile), StandardCharsets.UTF_8);
                writer.write(content);
                writer.flush();
                writer.close();

                // Notify user on the UI thread
                final String savedPath = outFile.getAbsolutePath();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(
                                MainActivity.this,
                                "Saved to Downloads: " + filename,
                                Toast.LENGTH_LONG
                        ).show();
                    }
                });

            } catch (Exception e) {
                final String errorMsg = e.getMessage();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(
                                MainActivity.this,
                                "Save failed: " + errorMsg,
                                Toast.LENGTH_LONG
                        ).show();
                    }
                });
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        WebSettings settings = webView.getSettings();

        // Enable JavaScript and localStorage
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());

        // Inject the download bridge into JavaScript as "AndroidBridge"
        webView.addJavascriptInterface(new DownloadBridge(), "AndroidBridge");

        // Load your index.html from assets
        webView.loadUrl("file:///android_asset/index.html");
    }

    // Handle back button — navigate WebView history
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
