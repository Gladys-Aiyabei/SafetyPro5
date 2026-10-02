// Copy this file to mail.config.js and fill in your mailbox details.
// mail.config.js is git-ignored so the password is not committed.
//
// Gmail: host smtp.gmail.com, port 465, secure true, and use an App Password
//        (Google Account > Security > 2-Step Verification > App passwords), not your normal password.
// Office 365: host smtp.office365.com, port 587, secure false.

module.exports = {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    user: "your.mailbox@example.com",
    pass: "app-password-here",
    from: "SafetyPro <your.mailbox@example.com>",

    // Address people use to open the app; used for the links in emails.
    // Use the PC's network name / IP (not localhost) if others open it from their own computers.
    appUrl: "http://localhost:3000"
};
