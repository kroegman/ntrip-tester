import test from 'node:test'; import assert from 'node:assert/strict';
process.env.NODE_ENV='test'; const { nmeaCoordinate, makeGga, validate } = await import('../server.mjs');
test('formats NMEA coordinates',()=>{assert.deepEqual(nmeaCoordinate(52.3676,'N','S',true),{value:'5222.0560',hemisphere:'N'});assert.deepEqual(nmeaCoordinate(-4.9041,'E','W',false),{value:'00454.2460',hemisphere:'W'});});
test('builds checksummed GGA',()=>{assert.match(makeGga(52.3676,4.9041),/^\$GPGGA,\d{6}\.00,5222\.0560,N,00454\.2460,E,1,12,1\.0,0\.0,M,0\.0,M,,\*[0-9A-F]{2}\r\n$/);});
test('validates limits',()=>{assert.throws(()=>validate({host:'x',mountpoint:'m',username:'u',connections:9999,latitude:0,longitude:0}),/Connections/);});
