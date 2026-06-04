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
    const since = new Date();
    since.setDate(since.getDate() - 31);
    imap.search([['SINCE', since], ['FROM', 'lindenhoff']], (err, results) => {
      console.log('Lindenhoff mails:', results ? results.length : 0);
      if (!results || results.length === 0) { imap.end(); return; }
      const f = imap.fetch(results, { bodies: '' });
      f.on('message', msg => {
        msg.on('body', stream => {
          simpleParser(stream, (err, parsed) => {
            console.log('Van:', parsed.from?.text);
            console.log('Onderwerp:', parsed.subject);
            console.log('Bijlagen:', parsed.attachments?.length || 0);
            parsed.attachments?.forEach(a => console.log(' -', a.filename, a.contentType));
          });
        });
      });
      f.once('end', () => imap.end());
    });
  });
});
imap.once('error', e => console.log('FOUT:', e.message));
imap.connect();
