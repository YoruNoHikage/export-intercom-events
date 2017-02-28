function createScheduler(fetchFn, options) {
  const queue = [];
  let isPaused = false;
  let running = false;
  let concurrency = options.concurrency || Infinity;
  let validateResponse = options.validateResponse || (() => true);

  function next() {
    running = true;
    if (queue.length === 0) {
      running = false;
      return;
    }
    if (isPaused || concurrency <= 0) {
      return;
    }

    concurrency--;

    const { request, resolve } = queue.shift();

    request().then(r => {
      if (validateResponse(r)) {
        isPaused = true;
        queue.push({ request, resolve });
        return setTimeout(
          () => {
            isPaused = false;
            concurrency++;
            next();
          },
          // TODO: find a way to ask the time to wait
          parseInt(r.headers.get('x-ratelimit-reset')) -
            parseInt(Date.now() / 1000)
        );
      }
      resolve(r);
      concurrency++;
      next();
    });

    next();
  }

  return function(...args) {
    let resolver = () => {};
    const promise = new Promise(resolve => {
      resolver = resolve;
    });
    queue.push({ request: () => fetchFn(...args), resolve: resolver });

    if (!running) {
      next();
    }

    return promise;
  };
}

module.exports = createScheduler;
