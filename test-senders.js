const Imap = require('imap');
const { simpleParser } = require('mailparser');
const imap = new Imap({
  user: 'facturen@europizza.rest',
  password: 'Euro2020Pizza!!!',
  host: 'imap.one.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
});
imap.once('ready', () => {
  imap.openBox('INBOX', true, (err) => {
    if (err) { console.log('FOUT:', err.message); imap.end(); return; }
    const since = new Date();
    since.setDate(since.getDate() - 31);
    imap.search([['SINCE', since]], (err, results) => {
      if (err) { imap.end(); return; }
      const f = imap.fetch(results, { bodies: 'HEADER.FIELDS (FROM SUBJECT)' });
      f.on('message', msg => {
        msg.on('body', stream => {
          simpleParser(stream, (err, parsed) => {
            if (!err) console.log(parsed.from?.text, '|', parsed.subject);
          });
        });
      });
      f.once('end', () => imap.end());
    });
  });
});
imap.once('error', e => console.log('FOUT:', e.message));
imap.connect();
