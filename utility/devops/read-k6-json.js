const { readFileSync, createReadStream } = require('fs');
let contents = createReadStream(process.argv[2], { encoding: 'utf8' });
/*console.log('got contents');
let lines = contents.split('\n');
console.log('got lines');*/
let lastDate = 0;
let total = 0;
let count = 0;
const interestingMetric = 'http_req_duration';
(async () => {
	for await (let chunk of contents) {
		let lines = chunk.toString().split('\n');
		for (let line of lines) {
			if (!line) continue;
			try {
				let measurement = JSON.parse(line);
				if (measurement.metric === interestingMetric) {
					let date = new Date(measurement.data.time).getTime();
					total += measurement.data.value;
					count++;
					/*
            if (measurement.data.value > 200 && measurement.metric.includes('duration')) {
                    console.log(measurement.data.time.split('T')[1], measurement.metric, measurement.data.value);
                }*/
					if (date > lastDate + 500) {
						console.log(measurement.data.time, total / count, count);
						lastDate = date;
						total = 0;
						count = 0;
					}
				}
			} catch (error) {}
		}
	}
})();
