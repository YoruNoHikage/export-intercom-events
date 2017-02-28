var fs = require('fs');
var Intercom = require('intercom-client');
var rawFetch = require('node-fetch');
const papa = require('papaparse');
const moment = require('moment');
const createScheduler = require('./queue');

const fetch = createScheduler(rawFetch, {
  concurrency: 400,
  validateResponse: r =>
    !r.ok && r.headers.get('x-ratelimit-remaining') === '0',
});

var flattenObject = function(ob) {
  var toReturn = {};

  for (var i in ob) {
    if (!ob.hasOwnProperty(i)) continue;

    if (typeof ob[i] == 'object') {
      var flatObject = flattenObject(ob[i]);
      for (var x in flatObject) {
        if (!flatObject.hasOwnProperty(x)) continue;

        toReturn[i + '.' + x] = flatObject[x];
      }
    } else {
      toReturn[i] = ob[i];
    }
  }
  return toReturn;
};

var intercom = new Intercom.Client({ token: process.env.INTERCOM_TOKEN });

function fetchEvents(url, events) {
  events = events || [];

  console.log('fetch', url);

  return fetch(url, {
    headers: {
      Authorization: 'Bearer ' + process.env.INTERCOM_TOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  })
    .then(r => {
      if (!r.ok) console.log(r.statusText, r.headers);
      return r.json();
    })
    .then(data => {
      events = events.concat(data.events);

      return data.pages.next ? fetchEvents(data.pages.next, events) : events;
    });
}

const headers = {};
const users = [];
const writeCSV = () => {
  const headersFirst = Object.keys(users[0]).reduce((h, prop) => {
    h[prop] = null;
    return h;
  }, {});

  users.unshift(Object.assign({}, headersFirst, headers));

  const csv = papa.unparse(users, { header: true });

  fs.writeFile(
    moment().format('DD_MM_YYYY') + '_paying_export.csv',
    csv,
    err => {
      if (err) throw err;
    }
  );
};

const formatDate = date => {
  if (!date) {
    return date;
  }

  return moment.unix(date).format('YYYY-MM-DD HH:mm:ss');
};

const transformProperties = user => {
  user.created_at = formatDate(user.created_at);
  user.remote_created_at = formatDate(user.remote_created_at);
  user.signed_up_at = formatDate(user.signed_up_at);
  user.updated_at = formatDate(user.updated_at);
  user.last_request_at = formatDate(user.last_request_at);

  const ca = user.custom_attributes;
  if (user.custom_attributes) {
    ca.stripe_card_expires_at = formatDate(ca.stripe_card_expires_at);
    ca.stripe_subscription_period_start_at = formatDate(
      ca.stripe_subscription_period_start_at
    );
    ca.stripe_last_charge_at = formatDate(ca.stripe_last_charge_at);
  }

  Object.keys(user.events).forEach(key => {
    const event = user.events[key];

    event.first_time_at = formatDate(event.first_time_at);
    event.last_time_at = formatDate(event.last_time_at);
  });

  return user;
};

// read the cache first
fs.readdir('./events', (err, files) => {
  if (err) throw err;

  const eventsCache = {};
  (files || []).forEach(filename => {
    const match = filename.match(/(\w+).json/);
    if (match && match[1]) {
      const id = match[1];
      eventsCache[id] = JSON.parse(fs.readFileSync('./events/' + filename));
    }
  });

  intercom.users.scroll.each({}, function(res) {
    const promises = res.body.users
      .filter(user => user.custom_attributes.stripe_plan)
      .map(user => {
        const addEvents = events => {
          user.events = events.reduce(
            (groupedEvents, event) => {
              headers['events.' + event.event_name + '.count'] = null;
              headers['events.' + event.event_name + '.first_time_at'] = null;
              headers['events.' + event.event_name + '.last_time_at'] = null;

              groupedEvents[event.event_name] = groupedEvents[
                event.event_name
              ] ||
                {};
              const ge = groupedEvents[event.event_name];

              ge.count = (ge.count || 0) + 1;
              if (!ge.first_time_at || event.created_at < ge.first_time_at) {
                ge.first_time_at = event.created_at;
              }
              if (!ge.last_time_at || event.created_at > ge.last_time_at) {
                ge.last_time_at = event.created_at;
              }

              return groupedEvents;
            },
            {}
          );

          users.push(flattenObject(transformProperties(user)));
        };

        if (eventsCache[user.id]) {
          console.log('cached', user.id);

          return Promise.resolve(addEvents(eventsCache[user.id]));
        }

        return fetchEvents(
          `https://api.intercom.io/events?type=user&intercom_user_id=${user.id}`
        ).then(events => {
          // write in cache
          fs.writeFile(
            `events/${user.id}.json`,
            JSON.stringify(events),
            err => {
              if (err) throw err;
            }
          );

          addEvents(events);
        });
      });
    return res.body.users.length < 1
      ? Promise.all(promises).then(writeCSV)
      : Promise.all(promises);
  });
});
