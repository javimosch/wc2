require('dotenv').config({
	silent: true
});
const express = require('express')
const app = express()
const server = require('http').Server(app);
const bodyParser = require('body-parser');
const parseForm = bodyParser.urlencoded({
	limit: '50mb',
	extended: false
})
const parseJson = bodyParser.json({
	limit: '50mb'
})
const _ = require('lodash');
const pug = require('pug');
const fs = require('fs');
const PORT = process.env.PORT || 3000;
const DB_URI = process.env.DB_URI
const mongoose = require('mongoose');
const path = require('path');
const VIEWS_BASE_DIR = __dirname
const sander = require('sander')
const requireFromString = require('require-from-string');
const cors = require('cors')

app._server = server
var require_install = require('require-install');
app.requireInstall = require_install

const io = require('socket.io')(server);
io.on('connection', function(socket) {
	console.log('Socket connected')
});

var socket
if (process.env.SOCKET_URI) {
	socket = require('socket.io-client')(process.env.SOCKET_URI);
}

socket.on('connect', function() {
	console.log('Socket online')
});
socket.on('event', function(data) {});
socket.on('disconnect', function() {});
socket.on('save-file', function() {
	console.log('SAVE FILE, EXIT')
	process.exit(0)
});


var cache = {};

app.data = {
	logged: false,
	views: {}
}


app.lazyFn = (n) => {
	return async (req, res, next) => {
		return app.fn[n](req, res, next)
	}
}
app.wait = (seconds) => {
	return new Promise((resolve, reject) => {
		setTimeout(() => resolve(), seconds * 1000)
	})
}
app.waitForFunction = async (n) => {
	if (app.function && app.function[n]) {
		return
	} else {
		for (var x = 1; x <= 20; x++) {
			await app.wait(1)
			if (app.function && app.function[n]) {
				return
			}
		}
	}
}
app.waitForService = async (n) => {
	if (app.service && app.service[n]) {
		return
	} else {
		for (var x = 1; x <= 20; x++) {
			await app.wait(1)
			if (app.service && app.service[n]) {
				return
			}
		}
	}
}

mongoose.set('debug', true);

configureDatabase().then(() => {
	configureMiddlewares()
	configureStaticRoutes()
	configureDynamicMiddlewares()
	//->configureFunctions
	//->configureServices
	//->configureDynamicRoutes
	//->onRouteDefinitionFinish
	//-> server listen
	configureDynamicViews()
})

async function getFiles(options) {
	var {
		types,
		tags
	} = options;
	var pr = await mongoose.model('simback_project').findOne({
		name: process.env.PROJECT,
	});
	if (!pr) {
		throw new Error('PR not found!')
	}
	if (types && !(types instanceof Array)) {
		types = [types];
	}
	var conditions = {
		_id: {
			$in: pr.files
		}
	};
	if (types && types.length > 0) {
		conditions.type = {
			$in: types
		}
	}
	if (tags && tags.length > 0) {
		conditions.tags = {
			$in: tags
		}
	}
	return await mongoose.model('simback_file').find(conditions).exec()
}
async function getFunction(name) {
	var pr = await mongoose.model('simback_project').findOne({
		name: process.env.PROJECT,
	});
	var conditions = {
		_id: {
			$in: pr.files
		},
		type: {
			$in: ['rpc', 'function']
		},
		name
	};
	return await mongoose.model('simback_file').findOne(conditions).exec()
}

function configureDynamicViews() {
	getFiles({
		types: ['pug']
	}).then(res => {
		console.log('Views', res.length)
		res.forEach(file => {
			try {
				file.name = file.name.split('.')[0]
				console.log('Loading view', file.name)
				app.data.views[file.name] = file.code
				sander.writeFileSync(path.join(process.cwd(), 'app/views/dynamic', file.name + '.pug'), file.code)
			} catch (err) {
				console.error(err.stack)
			}
		})

	})
}

function configureDynamicMiddlewares() {
	getFiles({
		types: ['middleware']
	}).then(res => {
		console.log('Middlewares', res.length)
		res.forEach(file => {
			try {
				console.log('Loading middleware', file.name)
				var mod = requireFromString(file.code)
				var middleware = mod(app)
				if (middleware instanceof Promise) {
					middleware.then(impl => {
						app.use(impl)
					}).catch(err => console.error(err.stack))
				} else {
					app.use(middleware)
				}

			} catch (err) {
				console.error(err.stack)
			}
		})
		configureFunctions()
	})
}

function configureMiddlewares() {
	app.use('/', express.static(path.join(process.cwd(), 'assets')));

	app.use((req, res, next) => {
		req.logged = app.data.logged || false;
		res.sendView = (name, data = {}) => {
			try {
				res.send(compileFileWithVars(name, data, req));
			} catch (err) {
				console.log(err);
				res.status(500).send('Ups');
			}
		}
		next();
	});

	app.use(parseJson, (req, res, next) => {
		console.log('REQ', req.method, req.url, Object.keys(req.body).map(k => k + (!req.body ? ':Empty' : '')).join(', '))
		next();
	})
}



function configureStaticRoutes() {

	app.get('/asset/:type/:name', async (req, res) => {
		var mongoose = require('mongoose')
		app.cache = app.cache || {}
		var cache = app.cache
		var id = () => {
			return `${process.env.PROJECT}_${req.params.type}_${req.params.name}`
		}
		try {
			var code = cache[id()] || ''
			if (!code) {
				var pr = await mongoose.model('simback_project').findOne({
					name: process.env.PROJECT,
				});
				var file = await mongoose.model('simback_file').findOne({
					name: req.params.name,
					type: req.params.type,
					_id: {
						$in: pr.files
					}
				}).exec();
				if (!file) {
					return res.send(`console.warn("WARN","File not found","${process.env.PROJECT}","${req.params.type}","${req.params.name}");`)
				}
				code = compileCode(file.code, true, {
					minified: req.query.minified === '1',
					type: file.type
				});
				cache[id()] = code;
			}
			res.type('.' + req.query.ext)
			res.send(code);
		} catch (err) {
			console.error('ERROR', err.stack)
			res.send(err.stack);
		}
	})



	app.get('/resource/:type/:name', async (req, res) => {
		// http://localhost:3000/resource/vueComponent/tma-benefits-progress?ext=js
		try {
			var code = cache[req.params.name] || ''
			if (!code) {
				var file = await mongoose.model('simback_file').findOne({
					name: req.params.name,
					type: req.params.type
				}).exec();
				code = compileCode(file.code, true, {
					minified: req.query.minified === '1',
					type: file.type
				});
				cache[file.name] = code;
			}
			res.type('.' + req.query.ext)
			res.send(code);
		} catch (err) {
			handleError(err, res, 404);
		}
	})

	app.post('/rpc/fetch', parseJson, async (req, res) => {
		try {
			let list = await mongoose.model('simback_file').find({
				//type: req.body.type
			}).exec();
			res.status(200).json(list);
		} catch (err) {
			handleError(err, res)
		}
	})

	app.post('/save-editor-file', parseJson, async (req, res) => {
		try {
			if (!req.body._id) {
				delete req.body._id;
			}
			delete cache[req.body.name];
			var payload = _.omit(req.body, ['_id', '__v', 'createdAt', 'updatedAt'])
			if (!req.body._id) {
				var d = await mongoose.model('simback_file').create(payload)
				payload._id = d._id
			} else {
				await mongoose.model('simback_file').findOneAndUpdate({
					_id: req.body._id //,
					//name: req.body.name
				}, payload, {
					upsert: true
				}).exec();
				payload._id = req.body._id
			}
			if (req.body.project) {
				let doc = await mongoose.model('simback_project').findById(req.body.project).exec()
				if (doc) {

					var conditions = {
						_id: req.body.project,
						'files._id': {
							$ne: payload._id
						}
					};
					var update = {
						$addToSet: {
							files: payload._id
						}
					}
					await mongoose.model('simback_project').findOneAndUpdate(conditions, update).exec()
				}
			}
			if (payload.type === 'pug') {
				configureDynamicViews()
			}
			if (payload.tags.includes('service')) {
				configureServices()
			}
			if (payload.type.includes('function')) {
				configureFunctions()
			}
			io.emit('save-file')
			res.status(200).json(req.body);
		} catch (err) {
			console.error('ERROR', err.stack)
			res.status(500).send(err.stack)
		}
	});

	app.post('/rpc/save-file', parseJson, async (req, res) => {
		try {
			if (!req.body._id) {
				delete req.body._id;
			}
			delete cache[req.body.name];
			var payload = _.omit(req.body, ['_id', '__v', 'createdAt', 'updatedAt'])
			if (!req.body._id) {
				var d = await mongoose.model('simback_file').create(payload)
				payload._id = d._id
			} else {
				await mongoose.model('simback_file').findOneAndUpdate({
					_id: req.body._id //,
					//name: req.body.name
				}, payload, {
					upsert: true
				}).exec();
				payload._id = req.body._id
			}

			if (req.body.project) {
				let doc = await mongoose.model('simback_project').findById(req.body.project).exec()
				if (doc) {

					var conditions = {
						_id: req.body.project,
						'files._id': {
							$ne: payload._id
						}
					};
					var update = {
						$addToSet: {
							files: payload._id
						}
					}
					await mongoose.model('simback_project').findOneAndUpdate(conditions, update).exec()
				}
			}

			res.status(200).json(req.body);
		} catch (err) {
			console.error(err.stack)
			res.status(500).send(err.stack)
		}
	});


	app.post('/rpc/:name', cors(), parseJson, async (req, res) => {
		if (!req.params.name) {
			return res.status(500).send((new Error('Name required')).stack)
		}
		let doc = await getFunction(req.params.name)
		try {
			var mod = requireFromString(doc.code)
			var fn = mod(app)
			if (!fn.apply) {
				throw new Error('Not a function: ' + fn.toString())
			}
			fn.apply({}, [req.body]).then(r => {
				res.status(200).json(r)
			}).catch(err => {
				console.error(err.stack)
				res.status(500).send(err.stack)
			})
		} catch (err) {
			console.error(err.stack)
			res.status(500).send(err.stack)
		}
	})
}

function configureFunctions() {
	getFiles({
		types: ['function']
	}).then(res => {
		res.forEach(file => {
			try {
				console.log('Loading function', file.name)
				var mod = requireFromString(file.code)
				if (!app.fn) {
					app.fn = {}
				}
				app.fn[file.name] = mod
			} catch (err) {
				console.error(err.stack)
			}
		})
		configureServices();
	})

}

function configureServices() {
	getFiles({
		types: ['service']
	}).then(res => {
		console.log('Services', res.length)
		res.forEach(file => {
			try {
				console.log('Loading service', file.name)
				var [name, impl] = requireFromString(file.code)
				if (!app.service) {
					app.service = {}
				}
				if (typeof impl === 'function') {
					impl(app).then(result => {
						app.service[name] = result
					})
				} else {
					app.service[name] = impl
				}

			} catch (err) {
				console.error(err.stack)
			}
		})
		configureDynamicRoutes()
	})
}

function configureDynamicRoutes() {
	getFiles({
		types: ['route']
	}).then(res => {
		console.log('Routes', res.length)
		res.forEach(file => {
			try {
				console.log('Loading route', file.name)
				var mod = requireFromString(file.code)
				mod(app)
			} catch (err) {
				console.error(err.stack)
			}
		})
		onRouteDefinitionFinish()
	})
}

function onRouteDefinitionFinish() {
	server.listen(PORT, function() {
		console.log('Listening on http://localhost:' + PORT)
	})
}

function handleError(err, res, status = 500) {
	console.error(err);
	res.status(status).json(err.stack);
}


function configureDatabase() {
	return new Promise((resolve, reject) => {
		if (!DB_URI) {
			console.error('DB_URI required')
			process.exit(0)
		}
		mongoose.connect(DB_URI, {
			server: {
				reconnectTries: Number.MAX_VALUE,
				reconnectInterval: 1000
			}
		});

		const schema = new mongoose.Schema({
			name: {
				type: String,
				required: true,
				unique: true,
				index: true
			},
			path: String,
			tags: [String],
			type: {
				type: String,
				required: true,
				//enum: ['view', 'function', 'route', 'vueComponent']
				//javascript, vueComponent, route, view, function, middleware, schedule)
			},
			code: {
				type: String,
				required: true
			}
		}, {
			timestamps: true,
			toObject: {}
		});
		mongoose.model('simback_file', schema);



		mongoose.model('simback_project', new mongoose.Schema({
			name: {
				type: String,
				required: true,
				unique: true,
				index: true
			},
			envs: Object,
			files: [{
				type: mongoose.Schema.Types.ObjectId,
				ref: 'simback_file'
			}],
			users: [{
				type: mongoose.Schema.Types.ObjectId,
				ref: 'simback_user'
			}],
		}, {
			timestamps: true,
			toObject: {}
		}));

		mongoose.model('simback_package', new mongoose.Schema({
			name: {
				type: String,
				required: true,
				unique: true,
				index: true
			},
			project: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'simback_project',
				index: true
			},
			files: [{
				type: mongoose.Schema.Types.ObjectId,
				ref: 'simback_file'
			}]
		}, {
			timestamps: true,
			toObject: {}
		}));



		getFiles({
			types: ['schema']
		}).then(res => {
			res.forEach(file => {
				try {
					console.log('Loading schema', file.name)
					var mod = requireFromString(file.code)
					mod(mongoose)
				} catch (err) {
					console.error(err.stack)
				}
			})
			resolve();
		})
	})
}


function compileFileWithVars(filePath, vars = {}, req) {
	var p = path.join(VIEWS_BASE_DIR, 'views', filePath.replace('.pug', '') + '.pug')
	if (sander.existsSync(p)) {
		return pug.compileFile(p)(vars)
	} else {
		p = path.join(VIEWS_BASE_DIR, 'views/dynamic', filePath.replace('.pug', '') + '.pug')
		return pug.compileFile(p)(vars)
	}
}


function compileCode(code, browser = false, opts = {
	minified: false,
	type: 'javascript'
}) {
	if (!['javascript', 'component'].includes(opts.type)) {
		return code;
	}
	var targets = {
		"node": "6.0"
	};
	if (browser) {
		delete targets.node;
		//targets.browsers = ["5%", "last 2 versions", "Firefox ESR", "not dead"];
		targets.chrome = '30';
	}
	return require('babel-core').transform(code, {
		minified: opts.minified,
		babelrc: false,
		sourceMaps: 'inline',
		presets: [
			["env", {
				"targets": targets
			}]
		]
	}).code;
}