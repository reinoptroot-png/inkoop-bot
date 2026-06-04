const Imap = require('imap');
const imap = new Imap({
  user: 'facturen@europizza.rest',
  password: 'Euro2020Pizza!!!',
  host: 'imap.one.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
});
imap.once('ready', () => { console.log('VERBINDING OK'); imap.end(); });
imap.once('error', (e) => { console.log('FOUT:', e.message); });
imap.connect();
