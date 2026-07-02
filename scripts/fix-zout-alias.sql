-- "zout" en "keukenzout" moeten ALTIJD op Fijn Zout matchen (exacte alias = score 1 in de resolver),
-- zodat Passard nooit meer vraagt. Grof/maldon/viking blijven eigen ingrediënten met eigen naam.
update inkoop_prijzen set aliassen = 'zout, keukenzout'
where id = '374025fb-08ca-8120-9ea8-cb7c82b50ac2';
