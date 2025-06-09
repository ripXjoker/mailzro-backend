// backend/server.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();

// --- DIAGNOSTIC LOGS & MIDDLEWARE CHAIN TRACING ---

// [STEP 1] Top-level request logger
app.use((req, res, next) => {
    console.log(`[STEP 1] ***** HIT SERVER ***** Method: ${req.method}, URL: ${req.originalUrl}, Timestamp: ${new Date().toISOString()}`);
    next();
});
console.log('[SERVER INIT] [STEP 1] Top-level request logger configured.');


// [STEP 2] CORS Configuration
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true
}));
console.log('[SERVER INIT] [STEP 2] Middleware: CORS applied.');
app.use((req, res, next) => {
    console.log('[STEP 2 Check] After CORS middleware.');
    next();
});

// [STEP 3] JSON Body Parser
app.use(express.json()); // Middleware to parse JSON bodies
console.log('[SERVER INIT] [STEP 3] Middleware: express.json applied.');
app.use((req, res, next) => {
    console.log('[STEP 3 Check] After express.json middleware.');
    next();
});

// [STEP 4] Cookie Session Configuration
if (!process.env.COOKIE_KEY) {
    console.error("FATAL ERROR: COOKIE_KEY is not defined in .env file.");
    process.exit(1);
}
app.use(
    cookieSession({
        name: 'email-cleaner-session',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        keys: [process.env.COOKIE_KEY],
        httpOnly: true,
    })
);
console.log('[SERVER INIT] [STEP 4] Middleware: cookieSession applied.');
app.use((req, res, next) => {
    console.log('[STEP 4 Check] After cookieSession middleware. req.session:', req.session);
    next();
});


// --- Remaining Server Initialization (unchanged, but numbered for clarity) ---

console.log('[SERVER INIT] [STEP 5] Google OAuth2 Client initialization...');
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    console.error("FATAL ERROR: Google OAuth credentials or redirect URI are not defined in .env file.");
    process.exit(1);
}
const oauth2ClientGlobal = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);
console.log('[SERVER INIT] [STEP 5] Google OAuth2 Client initialized.');


console.log('[SERVER INIT] [STEP 6] Mongoose User model definition...');
const userSchema = new mongoose.Schema({
    googleId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true },
    displayName: String,
    accessToken: String,
    refreshToken: { type: String, required: true },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
console.log('[SERVER INIT] [STEP 6] Mongoose User model defined.');


console.log('[SERVER INIT] [STEP 7] MongoDB connection initiation...');
if (!process.env.MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI is not defined in .env file.");
    process.exit(1);
}
mongoose.connection.on('connecting', () => console.log('MongoDB: status - connecting...'));
mongoose.connection.on('connected', () => console.log('MongoDB: status - connected!'));
mongoose.connection.on('open', () => console.log('MongoDB: status - connection open!'));
mongoose.connection.on('error', (err) => console.error('MongoDB: event - connection error:', err));
mongoose.connection.on('disconnected', () => console.log('MongoDB: status - disconnected.'));

console.log(`MongoDB: Attempting to connect to URI: ${process.env.MONGO_URI}`);
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB: mongoose.connect() promise resolved.'))
    .catch(err => {
        console.error('MongoDB: mongoose.connect() promise rejected. Error:', err);
        // process.exit(1); // Keep commented for debugging
    });
console.log('[SERVER INIT] [STEP 7] MongoDB connection initiation complete.');


// --- Helper function to get an authenticated Gmail API client for a user ---
async function getGmailClient(userId) {
    console.log(`[HELPER] getGmailClient: Starting for user ${userId}`);
    const user = await User.findById(userId);
    if (!user) {
        console.error(`[HELPER] getGmailClient: User not found for ID ${userId}`);
        throw new Error('User not found for Gmail client setup');
    }
    if (!user.refreshToken) {
        console.error(`[HELPER] getGmailClient: User ${userId} does not have a refresh token`);
        throw new Error('User does not have a refresh token. Please re-authenticate.');
    }
    console.log(`[HELPER] getGmailClient: User ${userId} found with refresh token.`);

    const userSpecificOAuth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
    userSpecificOAuth2Client.setCredentials({ refresh_token: user.refreshToken });
    userSpecificOAuth2Client.on('tokens', async (tokens) => {
        // This 'tokens' event fires when an access token is refreshed
        console.log(`[HELPER] Tokens event fired for user ${user._id}: New access token obtained.`);
        user.accessToken = tokens.access_token;
        if (tokens.refresh_token) {
            user.refreshToken = tokens.refresh_token; // Save new refresh token if provided
            console.log('[HELPER] New refresh token also provided and saved.');
        }
        await user.save();
        console.log(`[HELPER] User ${user._id} tokens updated in DB.`);
    });
    try {
        // This will refresh the access token if it's expired or missing
        if (!userSpecificOAuth2Client.credentials.access_token) {
            console.log(`[HELPER] No current access token, attempting to get new one for user ${user._id}`);
            // This call will trigger the 'tokens' event listener above if a new token is issued
            await userSpecificOAuth2Client.getAccessToken();
            console.log(`[HELPER] New access token obtained for user ${user._id}.`);
        } else {
            console.log(`[HELPER] Access token already exists for user ${user._id}.`);
        }
    } catch (refreshError) {
        console.error(`[HELPER] Error refreshing access token for user ${user._id}:`, refreshError.message);
        throw refreshError; // Re-throw to be caught by the route handler
    }
    console.log('[HELPER] getGmailClient: OAuth client ready.');
    return google.gmail({ version: 'v1', auth: userSpecificOAuth2Client });
}


// --- AUTHENTICATION ROUTES ---
app.get('/auth/google', (req, res) => {
    console.log('[ROUTE] /auth/google hit');
    // --- IMPORTANT: CHOOSE YOUR SCOPES CAREFULLY ---
    // If you want to move to trash, gmail.modify is generally sufficient.
    // If you want to permanently delete bypassing trash, use https://mail.google.com/
    // The front-end warning suggests moving to trash, which google.gmail.users.messages.batchDelete does by default.

    const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.labels',
    // Replace this line:
    // 'https://www.googleapis.com/auth/gmail.modify',
    // With this line:
    'https://mail.google.com/' // Use the broader scope as requested by the API
];
    const authorizationUrl = oauth2ClientGlobal.generateAuthUrl({
        access_type: 'offline', // Request a refresh token
        scope: scopes.join(' '),
        prompt: 'consent' // Forces consent screen to always get refresh token
    });
    res.redirect(authorizationUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    console.log('[ROUTE] /auth/google/callback hit - processing...');
    const { code } = req.query;
    try {
        const { tokens } = await oauth2ClientGlobal.getToken(code);
        oauth2ClientGlobal.setCredentials(tokens);

        const oauth2 = google.oauth2({
            auth: oauth2ClientGlobal,
            version: 'v2'
        });
        const { data } = await oauth2.userinfo.get();
        console.log('[ROUTE] Google user info received:', data);

        let user = await User.findOne({ googleId: data.id });
        if (!user) {
            console.log('[ROUTE] New user, creating DB entry.');
            user = new User({
                googleId: data.id,
                email: data.email,
                displayName: data.name,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token, // Crucial: save the refresh token
            });
        } else {
            console.log('[ROUTE] Existing user, updating tokens.');
            user.accessToken = tokens.access_token;
            // Only update refresh token if a new one is provided (they are not always)
            if (tokens.refresh_token) {
                user.refreshToken = tokens.refresh_token;
            }
        }
        await user.save();
        console.log('[ROUTE] User saved to DB. User ID:', user._id.toString());

        req.session.userId = user._id.toString(); // Store user ID in session
        console.log('[ROUTE] Session userId set. Redirecting to dashboard.');
        res.redirect('http://localhost:3000/dashboard');
    } catch (error) {
        console.error('[ROUTE] Error in Google OAuth callback:', error);
        res.status(500).send(`Authentication failed: ${error.message}`);
    }
});

// --- API ROUTES ---

// PING TEST ROUTE
app.get('/api/ping', (req, res) => {
    console.log('[ROUTE] /api/ping hit!');
    res.status(200).send('pong from backend');
});

// CURRENT USER ROUTE
app.get('/api/current_user', async (req, res) => {
    console.log('[ROUTE] /api/current_user hit. Session object:', req.session);
    if (req.session && req.session.userId) {
        const user = await User.findById(req.session.userId).select('-accessToken -refreshToken');
        if (user) {
            console.log('[ROUTE] User authenticated and found:', user.email);
            res.json({ isAuthenticated: true, user });
        } else {
            console.log('[ROUTE] User ID in session but user not found in DB.');
            res.json({ isAuthenticated: false });
        }
    } else {
        console.log('[ROUTE] No userId in session. User not authenticated.');
        res.json({ isAuthenticated: false });
    }
});

// LOGOUT ROUTE
app.get('/api/logout', (req, res) => {
    console.log('[ROUTE] /api/logout hit. Clearing session.');
    req.session = null; // Clear the session
    res.json({ success: true, message: 'Logged out successfully' });
});


// DELETE ALL GMAIL MESSAGES ROUTE
app.post('/api/v2/gmail/delete-all-messages', async (req, res) => {
    console.log('[ROUTE] [DELETE] <<<<< Route: /api/v2/gmail/delete-all-messages EXECUTING! >>>>>');

    if (!req.session || !req.session.userId) {
        console.log('[ROUTE] [DELETE] User not authenticated (no session userId)');
        return res.status(401).json({ error: 'User not authenticated' });
    }

    const userId = req.session.userId;
    console.log(`[ROUTE] [DELETE] Authenticated user ID: ${userId}`);

    try {
        console.log(`[ROUTE] [DELETE] Getting Gmail client for user ID: ${userId}`);
        const gmail = await getGmailClient(userId);

        // --- Fetch ALL message IDs for the user ---
        console.log('[ROUTE] [DELETE] Fetching all message IDs for deletion...');
        let allMessageIds = [];
        let pageToken = null;

        do {
            const response = await gmail.users.messages.list({
                userId: 'me',
                maxResults: 500, // Max allowed per page
                pageToken: pageToken
            });

            const messages = response.data.messages || [];
            const currentMessageIds = messages.map(msg => msg.id);
            allMessageIds = allMessageIds.concat(currentMessageIds);
            pageToken = response.data.nextPageToken;

            console.log(`[ROUTE] [DELETE] Fetched ${currentMessageIds.length} messages. Total: ${allMessageIds.length}. Next page token: ${pageToken}`);

        } while (pageToken); // Continue fetching until no more pages

        if (allMessageIds.length === 0) {
            console.log('[ROUTE] [DELETE] No messages found to delete.');
            return res.status(200).json({
                message: "No messages found to delete.",
                deletedCount: 0,
                userId: userId
            });
        }

        console.log(`[ROUTE] [DELETE] Attempting to delete ${allMessageIds.length} messages.`);

        // --- Perform Batch Delete ---
        // IMPORTANT: gmail.users.messages.batchDelete MOVES messages to the TRASH, it does NOT permanently delete them.
        // Permanent deletion from trash happens automatically after about 30 days, or requires explicit deletion from trash.
        const BATCH_SIZE = 1000; // You can adjust this based on testing
        let deletedCount = 0;

        for (let i = 0; i < allMessageIds.length; i += BATCH_SIZE) {
            const batch = allMessageIds.slice(i, i + BATCH_SIZE);
            console.log(`[ROUTE] [DELETE] Deleting batch ${Math.floor(i/BATCH_SIZE) + 1} of ${batch.length} messages...`);
            await gmail.users.messages.batchDelete({
                userId: 'me',
                requestBody: {
                    ids: batch
                }
            });
            deletedCount += batch.length;
            console.log(`[ROUTE] [DELETE] Batch deleted. Total deleted: ${deletedCount}`);
        }

        console.log(`[ROUTE] [DELETE] Successfully moved all ${deletedCount} messages to trash.`);
        res.status(200).json({
            message: `Successfully moved ${deletedCount} Gmail messages to trash.`,
            deletedCount: deletedCount,
            userId: userId
        });

    } catch (error) {
        console.error('[ROUTE] [DELETE] Error deleting Gmail messages:', error.message);
        console.error('[ROUTE] [DELETE] Full error object:', error);

        if (error.code === 401 || error.message.includes('re-authenticate')) {
            return res.status(401).json({
                error: 'Authentication required: Please re-authenticate with Google.',
                details: error.message
            });
        }
        // This is the specific 403 error we are debugging
        if (error.code === 403) {
            return res.status(403).json({
                error: 'Permission denied: Check Gmail API scopes or enable API.',
                details: error.message,
                googleApiErrors: error.errors // Often contains more specific error reasons from Google
            });
        }

        res.status(500).json({
            error: 'Failed to delete Gmail messages.',
            details: error.message,
            fullError: error
        });
    }
});


// GMAIL MESSAGES ROUTE - Re-introducing Gmail API logic (already working)
app.get('/api/v2/gmail/list-messages', async (req, res) => {
    console.log('[ROUTE] [GMAIL] <<<<< Route: /api/v2/gmail/list-messages EXECUTING! >>>>>');

    if (!req.session || !req.session.userId) {
        console.log('[ROUTE] [GMAIL] User not authenticated (no session userId)');
        return res.status(401).json({ error: 'User not authenticated' });
    }

    const userId = req.session.userId;
    console.log(`[ROUTE] [GMAIL] Authenticated user ID: ${userId}`);

    try {
        console.log(`[ROUTE] [GMAIL] Attempting to get Gmail client for user ID: ${userId}`);
        const gmail = await getGmailClient(userId);
        console.log(`[ROUTE] [GMAIL] Gmail client obtained for user ID: ${userId}. Attempting to list messages.`);

        // List messages
        const response = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 10 // Adjust as needed, or remove for default (100)
        });

        const messages = response.data.messages || [];
        console.log(`[ROUTE] [GMAIL] Found ${messages.length} messages.`);

        if (messages.length === 0) {
            console.log('[ROUTE] [GMAIL] No messages found for this user.');
            return res.status(200).json({
                message: "No messages found.",
                messages: [],
                userId: userId
            });
        }

        // You might want to fetch details for each message here if needed
        // For now, let's just return the message IDs
        console.log('[ROUTE] [GMAIL] Sending list of message IDs.');
        res.status(200).json({
            message: "Successfully listed Gmail messages.",
            messages: messages, // This will contain message IDs and thread IDs
            userId: userId
        });

    } catch (error) {
        console.error('[ROUTE] [GMAIL] Error listing Gmail messages:', error.message);
        console.error('[ROUTE] [GMAIL] Full error object:', error); // Log full error for more details

        // Handle specific Google API errors or authentication issues
        if (error.code === 401 || error.message.includes('re-authenticate')) {
            return res.status(401).json({
                error: 'Authentication required: Please re-authenticate with Google.',
                details: error.message
            });
        }
        if (error.code === 403) {
            return res.status(403).json({
                error: 'Permission denied: Check Gmail API scopes or enable API.',
                details: error.message,
                googleApiErrors: error.errors // Often contains more specific error reasons from Google
            });
        }

        res.status(500).json({
            error: 'Failed to list Gmail messages.',
            details: error.message,
            fullError: error // Include full error for debugging if needed
        });
    }
});


// [STEP 5] Fallback: If no route matches by this point
app.use((req, res) => {
    console.log(`[STEP 5] Fallback: No route matched for ${req.method} ${req.originalUrl}. Sending 404.`);
    res.status(404).send('Cannot GET ' + req.originalUrl + ' (No specific route handler found)');
});


// --- Start the Server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`[SERVER INIT] Express server started. Running on http://localhost:${PORT}`);
});