const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const scope = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../infra/cloudfront/category-path-compat.js'), 'utf8'), scope);
for (const [input, output] of [
  ['/wallpapers/pfp/photo.jpg', '/pfp/photo.jpg'],
  ['/wallpapers/baki/photo%20one.png', '/baki/photo%20one.png'],
  ['/wallpapers.json', '/wallpapers.json'],
  ['/wallpapers_v2.json', '/wallpapers_v2.json'],
  ['/wallpapers-secure', '/wallpapers-secure'],
  ['/desktop_wallpapers/desktop/photo.png', '/desktop_wallpapers/desktop/photo.png'],
  ['/thumbs/pfp/photo.webp', '/thumbs/pfp/photo.webp'],
  ['/wallpapers/session.json', '/wallpapers/session.json'],
]) {
  const request = {uri: input, method: 'GET', querystring: {token: {value: 'unchanged'}}, headers: {}};
  const result = scope.handler({request});
  assert.equal(result, request);
  assert.equal(result.uri, output);
  assert.equal(result.querystring.token.value, 'unchanged');
}
console.log('CloudFront path compatibility: 8 cases passed');
