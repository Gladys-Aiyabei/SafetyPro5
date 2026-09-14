const express = require('express');
const router = express.Router();

// TODO: replace this with your real user store / DB lookup and
// a proper password hash comparison (e.g. bcrypt.compare).
const USERS = [
  { id: 1, email: 'admin@safetypro.local', password: 'admin123', name: 'Admin', role: 'admin' },
];

// GET /login — show the login form
router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

// POST /login — authenticate the submitted credentials
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  const user = USERS.find(
    (u) => u.email.toLowerCase() === String(email || '').toLowerCase()
  );

  if (!user || user.password !== password) {
    return res.status(401).render('login', {
      error: 'Incorrect email or password.',
    });
  }

  // Store the logged-in user on the session.
  // Requires express-session to be configured in app.js:
  //   const session = require('express-session');
  //   app.use(session({ secret: 'change-me', resave: false, saveUninitialized: false }));
  req.session.user = { id: user.id, name: user.name, role: user.role };

  res.redirect('/dashboard');
});

module.exports = router;
