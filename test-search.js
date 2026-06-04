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
    
    const since = new Date();
    since.setDate(since.getDate() - 31);
    
    imap.search([['SINCE', since]], (err, results) => {
      if (err) { console.log('Search FOUT:', err.message); imap.end(); return; }
      console.log('Mails afgelopen 31 dagen:', results ? results.length : 0);
      imap.end();
    });
  });
});
imap.once('error', e => console.log('FOUT:', e.message));
imap.connect();
