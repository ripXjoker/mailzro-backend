// temp_test_server.js
const express = require('express');
const app = express();
const PORT = 5000;

// Diagnostic Middleware - should always hit
app.use((req, res, next) => {
    console.log(`[TEMP] Request received: ${req.method} ${req.url}`);
    next(); // IMPORTANT: Pass control to the next middleware/route
});

// Diagnostic Route - should definitely hit
app.get('/simple-test', (req, res) => {
    console.log('[TEMP] !!!!!!!! SIMPLE TEST ROUTE EXECUTING !!!!!!!!');
    res.send('This is a completely simple test route!');
});

// If no route matches by this point, it will fall through to here
app.use((req, res) => {
    console.log(`[TEMP] Fallback: No route matched for ${req.method} ${req.url}`);
    res.status(404).send('Not Found: This is from the fallback handler in temp_test_server.js');
});


app.listen(PORT, () => {
    console.log(`[TEMP] Minimal Express server running on http://localhost:${PORT}`);
});