/**
 * scripts/setup_gdrive_storage.js
 * ============================================================================
 * One-Step Google Drive 15GB–45GB Storage Vault Token Generator.
 * Uses your existing GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from .env
 * to authorize Google Drive API v3 and print your GDRIVE_REFRESH_TOKEN.
 *
 * Usage:
 *   node scripts/setup_gdrive_storage.js
 * ============================================================================
 */

require('dotenv').config();
const readline = require('readline');

const clientId = process.env.GDRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GDRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = 'https://developers.google.com/oauthplayground';

if (!clientId || !clientSecret) {
    console.error('❌ GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing in .env!');
    process.exit(1);
}

const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.file');
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;

console.log('\n====================================================================');
console.log('🚀 ELEMENTA LMS — 15GB-45GB GOOGLE DRIVE CLOUD VAULT SETUP');
console.log('====================================================================\n');
console.log('Step 1: In Google Cloud Console -> APIs & Services -> Credentials:');
console.log('        Make sure "https://developers.google.com/oauthplayground" is added');
console.log('        under "Authorized redirect URIs", and enable "Google Drive API".\n');
console.log('Step 2: Open this URL in your browser and sign in with the Google account');
console.log('        where you want to store your LMS files (15 GB free per account):\n');
console.log(authUrl);
console.log('\nStep 3: After authorizing, copy the "Authorization code" shown on the page');
console.log('        (or in the URL parameter ?code=...) and paste it below:\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste Authorization Code here: ', async (code) => {
    rl.close();
    const cleanCode = decodeURIComponent(code.trim());
    try {
        const params = new URLSearchParams({
            code: cleanCode,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        });
        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const data = await resp.json();
        if (!resp.ok || !data.refresh_token) {
            console.error('\n❌ Failed to exchange code:', data);
            process.exit(1);
        }
        console.log('\n✅ SUCCESS! Add this line to your .env and Render Environment Variables:\n');
        console.log(`GDRIVE_REFRESH_TOKEN=${data.refresh_token}\n`);
    } catch (err) {
        console.error('\n❌ Error:', err.message);
    }
});
