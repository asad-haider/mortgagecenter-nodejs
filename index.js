// We'll use Puppeteer is our browser automation framework.
const fs = require('fs');
const parse = require('csv-parse');
const getStream = require('get-stream');
const randomUA = require('modern-random-ua');
const { Cluster } = require('puppeteer-cluster');
const createCsvWriter = require('csv-writer').createArrayCsvWriter;
const MAX_CONCURRENCY = 10;

const readCSVData = async (filePath) => {
	const parseStream = parse({
		delimiter: ','
	});
	const data = await getStream.array(fs.createReadStream(filePath).pipe(parseStream));
	return data;
}
// This is where we'll put the code to get around the tests.
const preparePageForTests = async (page) => {
	// Pass the User-Agent Test.
	// const userAgent = 'Mozilla/5.0 (X11; Linux x86_64)' +
	//     'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.39 Safari/537.36';
	const userAgent = randomUA.generate();
	await page.setUserAgent(userAgent);

	// Pass the Webdriver Test.
	await page.evaluateOnNewDocument(() => {
		Object.defineProperty(navigator, 'webdriver', {
			get: () => false,
		});
	});

	// Pass the Chrome Test.
	await page.evaluateOnNewDocument(() => {
		// We can mock this in as much depth as we need for the test.
		window.navigator.chrome = {
			runtime: {},
			// etc.
		};
	});

	// Pass the Permissions Test.
	await page.evaluateOnNewDocument(() => {
		const originalQuery = window.navigator.permissions.query;
		return window.navigator.permissions.query = (parameters) => (
			parameters.name === 'notifications' ?
				Promise.resolve({
					state: Notification.permission
				}) :
				originalQuery(parameters)
		);
	});

	// Pass the Plugins Length Test.
	await page.evaluateOnNewDocument(() => {
		// Overwrite the `plugins` property to use a custom getter.
		Object.defineProperty(navigator, 'plugins', {
			// This just needs to have `length > 0` for the current test,
			// but we could mock the plugins too if necessary.
			get: () => [1, 2, 3, 4, 5],
		});
	});

	// Pass the Languages Test.
	await page.evaluateOnNewDocument(() => {
		// Overwrite the `plugins` property to use a custom getter.
		Object.defineProperty(navigator, 'languages', {
			get: () => ['en-US', 'en'],
		});
	});

	await page.viewport({
		width: 1024 + Math.floor(Math.random() * 100),
		height: 768 + Math.floor(Math.random() * 100),
	});

	const blockedResourceTypes = ['image', 'media', 'font', 'texttrack', 'object', 'beacon', 'csp_report', 'imageset'];
	const skippedResources = ['quantserve', 'adzerk', 'doubleclick', 'adition', 'exelator', 'sharethrough', 'cdn.api.twitter',
		'google-analytics', 'googletagmanager', 'google', 'fontawesome', 'facebook', 'analytics', 'optimizely', 'clicktale', 'mixpanel',
		'zedo', 'clicksor', 'tiqcdn'];
	await page.setRequestInterception(true);
	page.on('request', request => {
		const requestUrl = request._url.split('?')[0].split('#')[0];
		if (
			blockedResourceTypes.indexOf(request.resourceType()) !== -1 ||
			skippedResources.some(resource => requestUrl.indexOf(resource) !== -1)
		) {
			request.abort();
		} else {
			request.continue();
		}
	});
	await page.evaluateOnNewDocument(function () {
		navigator.geolocation.getCurrentPosition = function (cb) {
			setTimeout(() => {
				cb({
					'coords': {
						accuracy: 21,
						altitude: null,
						altitudeAccuracy: null,
						heading: null,
						latitude: 23.129163,
						longitude: 113.264435,
						speed: null
					}
				})
			}, 1000)
		}
	});
}
const dataHelper = async (page, selector, selection, parent, index = 0, merge = false, separator = '') => {
	const elements = await (parent || page).$x(selector);
	if (merge) {
		const values = await page.evaluate((selection, ...links) => links.map(e => e[selection]), selection, ...elements);
		return values.join(separator);
	} else if (elements && elements.length)
		return await page.evaluate((elements, selection) =>
			elements[selection] ? elements[selection].trim() : elements[selection],
			elements[index], selection);
	else return '';
}

(async () => {
	const dataArray = [];
	const pageUrls = (await readCSVData('urls.csv')).map(row => row[0]);
	const writer = createCsvWriter({
		header: [
			'Url',
			'FullName',
			'FirstName',
			'LastName',
			'Address',
			'City',
			'Province',
		],
		path: 'Data.csv'
	});
	const cluster = await Cluster.launch({
		concurrency: Cluster.CONCURRENCY_CONTEXT,
		maxConcurrency: MAX_CONCURRENCY,
		monitor: false,
		retryLimit: 100,
		puppeteerOptions: {
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--disable-accelerated-2d-canvas',
				'--disable-gpu',
				'--window-size=1920x1080'
			],
			headless: true,
		},
		timeout: 120000
	})
	for (let pageUrl of pageUrls) {
		await cluster.queue({
			url: pageUrl,
			dataUrl: false,
		});
	}
	await cluster.task(async ({ page, data: data }) => {
		await preparePageForTests(page);
		await page.setExtraHTTPHeaders({ 'Cookie': '_ga=GA1.2.1787252445.1549643291; PHPSESSID=n4e1crmtlvp2vqum3d5hra5l70; _gid=GA1.2.331480867.1549776478' });
		await page.goto(data.url, { timeout: 120000 });
		if (!data.dataUrl) {
			await page.waitForXPath('//li/a[text()="View Details"]')
			const listings = await page.$x('//li/a[text()="View Details"]');
			const listingUrls = await page.evaluate((...links) => links.map(e => e.href), ...listings);
			console.log('Listing Urls found: ' + listingUrls.length);
			for (let listingUrl of listingUrls)
				await cluster.queue({
					dataUrl: true,
					url: listingUrl,
				});
		}
		else {
			await page.waitForXPath('//div[@class="address"]/h2')
			let full_name = await dataHelper(page, '//div[@class="address"]/h2', 'textContent');
			let address = await dataHelper(page, '//div[@class="address"]/h2/following::div[1]//div[2]/p', 'textContent', null, true, ' ');
			let first_name = '', last_name = '';
			if (full_name.includes(' ')) {
				split_names = full_name.split(' ')
				first_name = split_names[0]
				last_name = split_names.filter((x, i) => i > 0).join(' ');
			} else
				first_name = full_name

			dataArray.push([
				data.url,
				full_name,
				first_name,
				last_name,
				address,
				'',
				'',
			]);
			console.log(data.url);
		}
	});
	cluster.on('taskerror', (err, data) => {
		console.log(`Error crawling ${data}: ${err.message}`);
	});
	await cluster.idle();
	await cluster.close();
	await writer.writeRecords(dataArray);
})();