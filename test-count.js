const Imap = require('imap');
const imap = new Imap({
  user: 'facturen@europizza.rest',
  password: 'Euro2020Pizza!!!',
  host: 'imap.one.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
});
imap.once('ready', () => {
  imap.openBox('INBOX', true, (err, box) => {
    if (err) { console.log('FOUT:', err.message); imap.end(); return; }
    console.log('Totaal mails in inbox:', box.messages.total);
    imap.end();
  });
});
imap.once('error', e => console.log('FOUT:', e.message));
imap.connect();
