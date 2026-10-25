// Preserve pre-migration mobile caches and shared links after moving S3 objects.
function handler(event) {
    var request = event.request;
    var prefix = '/wallpapers/';
    if (request.uri.indexOf(prefix) === 0 &&
        /^\/wallpapers\/[^/]+\/.+\.(jpg|jpeg|png|webp)$/i.test(request.uri)) {
        request.uri = '/' + request.uri.slice(prefix.length);
    }
    return request;
}
