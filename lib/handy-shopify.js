// main functionality for Handy-Shopify.js

//'use strict';

const path = require('path')
  , crypto = require('crypto')
  , url = require('url')
  , EventEmiter = require('events')
  , _ = require('underscore')
  , uuidv4 = require('uuid/v4')
  , express = require('express')
  , cors = require('cors')
  , handy = require('@takinola/handy')
  , shopifyAPI = require('shopify-node-api')
  , superagent = require('superagent')
  , location = require(path.join(__dirname, 'location'))
  , product = require(path.join(__dirname, 'product'))
;

/*
 * include sub module
*/
exports.analytics = require(path.join(__dirname, 'analytics'));
exports.location = location;
exports.product = product;

/* FLAGS */
const TEST_PLANS = {
  ['Development']: true,
  ['Developer Preview']: true,
  ['staff']: true,
};

/*
 * initialize handy-shopify
 * create database tables (store)
 * set up routes and views directorys
 *
 * @api public
 */
exports.initialize = initialize;

function initialize(app){
  // shopify enforces CORS in a number of different places so enable CORS across all paths
  app.use(cors());

  // get current version (used for things like attaching version numbers to js and css files)
  const handy_shopify_version = require(path.join(__dirname, '..', 'package.json')).version;
  let handyModuleVersions = handy.system.systemGlobal.get('handy_module_versions') || {};
  handyModuleVersions.handy_shopify_version = handy_shopify_version;
  handy.system.systemGlobal.set('handy_module_versions', handyModuleVersions);

  // set enumeration of shopify plans
  const shopifyPlanList = ['professional', 'npo_lite', 'custom', 'grandfather', 'unlimited', 'staff',
    'staff_business', 'affiliate', 'trial', 'dormant', 'npo_full', 'basic', 'comped', 'starter', 'partner_test',
    'business', 'frozen', 'shopify_plus', 'plus_partner_sandbox'
  ];

  handy.system.systemGlobal.set('shopify_plan_list', shopifyPlanList);

  // set path for configuration view
  let configurationViews = handy.system.systemGlobal.get('configuration_views') || {};
  configurationViews.Shopify = 'configuration/shopify';
  handy.system.systemGlobal.set('configuration_views', configurationViews);

  /* create internal url call global
   * NOTE: This enables the local app redirects to bypass validations safely
   * e.g. res.redirect(path/will/bypass/normal/shopify/request/validation)
   */
  handy.system.systemGlobal.set('internal_url_request_hash_validation', []);

  // path that bypasses CSRF protection
  // must be declared above routes
  const bypass_csrf_path = handy.system.systemGlobal.get('bypass_csrf_path');

  // webhook path
  handy.system.systemGlobal.set('webhooks_base_path', bypass_csrf_path + '/shopify/webhooks');

  // app proxy path
  handy.system.systemGlobal.set('app_proxy_base_path', bypass_csrf_path + '/shopify/app_proxy');

  // add views (NOTE: using app.set('views', views_directory) will override all other views so use handy.addViews instead)
  handy.addViews(app, path.join(__dirname, '..', 'views'));

  // add post install functions i.e. functions executed whenever a customer installs the app
  addPostAppInstallFunctions([_updateShopDetails, _createWebhooks]);

  // set default webhooks
  handy.system.systemGlobal.set('handy_shopify_default_webhooks', _getDefaultWebhooks());

  // add webhook processors
  addWebhookProcessors({
    app_uninstalled: _uninstallShop,
    shop_update: _updateShop,
    redact_shop_data: _redactShopData,
  });

  // create cron tasks to process shopify webhooks
  const cronTasks = [
    {name: 'shopify_webhooks', run: processWebhookQueue, freq: 30},
  ];

  // create triggers
  const triggers = [
    {name: 'shop installed', actions: [] },
    {name: 'shop uninstalled', actions: []}
  ];

  /*
   * define functions to run only DIRECTLY AFTER handy is fully installed
   * NOTE: These functions are only run ONCE in the lifetime of the app
   *       They run right after handy installation is complete
   *       They do NOT run each time the app restarts
  */
  const postInitializationScripts = [];
  postInitializationScripts.push(_shopifyInstall);
  postInitializationScripts.push(handy.system.addCronTasks.bind(null, cronTasks));
  postInitializationScripts.push(handy.system.addTriggers.bind(null, triggers));
  postInitializationScripts.push(setShopifyBillingActivationPath);

  return handy.addInstallFunctions(postInitializationScripts)
    .then(_setRoutes.bind(null, app))
    .then(()=>{
      /*
       * define functions to run UPON STARTUP only if handy is installed
       * NOTE: These functions run each time the app starts or restarts as long
       *       handy has been installed
      */
      if(handy.system.systemGlobal.get('installation_flag')){
        return handy.system.addCronTasks(cronTasks)
          .then(()=> handy.system.addTriggers(triggers))
          .then(()=> setShopifyBillingActivationPath())
          .then(()=> loadInstalledShops());
      }
    });
}


/*
 * run installation of handy-shopify
 * set up config settings and create database tables
 */
function _shopifyInstall(){
  // initialize shopify config
  const shopifyConfig = {
    shopify_api_key: null,
    shopify_shared_secret: null,
    shopify_api_scope: null,
    shopify_redirect_url: handy.system.systemGlobal.getConfig('siteURL') + '/handy/shopify/install_redirect_uri'
  }

  return handy.system.systemGlobal.updateConfig(shopifyConfig)
    .then(_createDatabaseTables)
}

// set routes
function _setRoutes(app){
  return new Promise((resolve, reject)=>{
    const routes = require(path.join(__dirname, '..', 'routes'))(app);

    // set up public directory
    app.use(express.static(path.join(__dirname, '..', 'public')));
    return resolve();
  })
}

function setShopifyBillingActivationPath() {
  return new Promise((resolve, reject)=>{
    // redirect path for shopify billing activation process
    const siteURL = handy.system.systemGlobal.getConfig('siteURL');
    handy.system.systemGlobal.set('billing_charge_activation_redirect_url', siteURL + '/handy/shopify/embed/billing_charge_activate');
    return resolve();
  })
}

exports.loadInstalledShops = loadInstalledShops;

// load all installed shops into memory
function loadInstalledShops() {
  return new Promise((resolve, reject)=>{
    let installedShops = [];
    const pool = handy.system.systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      if(err){return reject(err); }

      const query = 'SELECT myshopify_domain, owner, email, shopify_plan, installed, deleted FROM shops';
      connection.query(query, (err, results)=>{
        connection.release();
        if(err){return reject(err); }
        _.forEach(results, (loadedShop)=>{
          installedShops.push(loadedShop);
        })

        handy.system.systemGlobal.set('installed_shops', installedShops);
        return resolve();
      })
    })
  })
}


class Shop extends handy.system.BaseClass {
  constructor({id=null, shopify_store_id=null, shopify_gql_store_id=null, domain=null, myshopify_domain=null, nonce=null,access_token=null,
                app_settings={}, emulations={}, admin_notifications={snoozeable:[], dismissable:[]}}, runtimeExtension=[]){

    const tableDefinition = {
      name: 'shops',
      columns: [
        {name: 'shopify_store_id', type: 'VARCHAR(48)'},
        {name: 'shopify_gql_store_id', type: 'VARCHAR(60)'},
        {name: 'address1', type: 'VARCHAR(512)'},
        {name: 'address2', type: 'VARCHAR(512)'},
        {name: 'city', type: 'VARCHAR(512)'},
        {name: 'province', type: 'VARCHAR(512)'},
        {name: 'province_code', type: 'VARCHAR(8)'},
        {name: 'zip', type: 'VARCHAR(16)'},
        {name: 'country_code', type: 'VARCHAR(16)'},
        {name: 'country', type: 'VARCHAR(512)'},
        {name: 'owner', type: 'VARCHAR(512)'},
        {name: 'email', type: 'VARCHAR(512)'},
        {name: 'phone', type: 'VARCHAR(32)'},
        {name: 'domain', type: 'TEXT'},
        {name: 'myshopify_domain', type: 'VARCHAR(4096)', index: true},  // NOTE: only one column can be index, unique or primary key
        {name: 'money_format', type: 'VARCHAR(64)'},
        {name: 'currency', type: 'VARCHAR(16)'},
        {name: 'shopify_plan', type: 'VARCHAR(64)'},
        {name: 'shopify_created_at', type: 'DATETIME'},
        {name: 'shopify_updated_at', type: 'DATETIME'},
        {name: 'nonce', type: 'VARCHAR(64)'},
        {name: 'access_token', type: 'VARCHAR(128)'},
        {name: 'app_settings', type: 'LONGTEXT', datatype: 'object'},
        {name: 'installed', type: 'BOOLEAN', default: false, datatype: 'boolean'},
        {name: 'emulations',type: 'VARCHAR(4096)', datatype: 'object'},
        {name: 'admin_notifications', type: 'LONGTEXT', datatype: 'object'}
      ],
    };

    super({id, shopify_store_id, shopify_gql_store_id, domain, myshopify_domain, nonce, access_token,
      app_settings, emulations, admin_notifications}, tableDefinition, runtimeExtension);
  }


  ShopifyGQL(){
    this.shopifyGQLEndPoint = `https://${this.myshopify_domain}/admin/api/${handy.system.systemGlobal.getConfig('shopify_api_version')}/graphql.json`;
    return superagent.post(this.shopifyGQLEndPoint)
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Access-Token', this.access_token);
  }


  // check if signature on an incomming shopify request is valid
  isValidSignature(params, non_state){
    if(!non_state && this.nonce !== params['state']){
      return false;
    }

    let hmac = params['hmac'],
      theHash = params['hmac'] || params['signature'],
      secret = handy.system.systemGlobal.getConfig('shopify_shared_secret'),
      parameters = [],
      digest,
      message;

    for (let key in params) {
      if (key !== "hmac" && key !== "signature") {
        parameters.push(key + '=' + params[key]);
      }
    }

    message = parameters.sort().join(hmac ? '&' : '');

    digest = crypto
      .createHmac('SHA256', secret)
      .update(message)
      .digest('hex');

    return ( digest === theHash );
  }


  createShopifyAPI(){
    let shopifyConfig = {
      shop: this.myshopify_domain,
      nonce: this.nonce,
      shopify_api_key: handy.system.systemGlobal.getConfig('shopify_api_key'),
      shopify_shared_secret: handy.system.systemGlobal.getConfig('shopify_shared_secret'),
      shopify_scope: handy.system.systemGlobal.getConfig('shopify_api_scope'),
      redirect_uri: handy.system.systemGlobal.getConfig('shopify_redirect_url'),
      verbose: false
    }

    // add access token, if available
    this.access_token ? shopifyConfig.access_token = this.access_token : null;

    this.Shopify = new shopifyAPI(shopifyConfig)

  }


  // initiate app install process on customer shop
  beginShopifyInstall(){
    return this.load(['myshopify_domain'])
      .then(()=>{
        if(this.installed){
          // redirect to frontpage
          const appFrontPageUrl = handy.system.systemGlobal.getConfig('siteURL') + '/handy/shopify/app';
          return Promise.resolve(appFrontPageUrl);
        }

        return _createNonce.bind(this)()
          .then(_buildAuthUrl.bind(this))

      })
      .catch((err)=>{
        // no instance of shop was found in database so continue install
        return _createNonce.bind(this)()
          .then(_buildAuthUrl.bind(this))
      })
  }


  // complete app install process on customer shop
  completeShopifyInstall(params){
    return this.load(['myshopify_domain'])
      .then(()=>{
        return new Promise((resolve, reject)=>{
          // stop processing if app is already installed
          if(this.installed){return resolve({installed: true}); }

          // stop processing if nonce is missing
          if(!this.nonce){return reject(new Error('completeShopifyInstall: error completing app install - app already installed or missing details')); }

          const payload = {
            client_id: handy.system.systemGlobal.getConfig('shopify_api_key'),
            client_secret: handy.system.systemGlobal.getConfig('shopify_shared_secret'),
            code: params.code
          }

          const destination = `https://${this.myshopify_domain}/admin/oauth/access_token`;

          return superagent.post(destination)
            .send(payload)
            .then((res)=>{
              this.access_token = res.body.access_token;
              // get default Shop app settings
              const defaultShopSettings = handy.system.systemGlobal.get('shopify_app_settings_default') || {};
              return this.updateShopSettings(defaultShopSettings)
                .then(()=> resolve())
                .catch(err => reject(err))
            })
        })
      })
      .then((flags)=>{
        // stop processing if app is already installed
        if(flags && flags.installed){return Promise.resolve(); }

        // post install functions e.g. get store details, theme modifications, install script tags, etc
        this.postAppInstallFunctions = handy.system.systemGlobal.get('handy_shopify_postAppInstallFunctions');
        const promiseFactory = (installFunction)=>{
          return installFunction.bind(this)()
        }

        let promiseChain = Promise.resolve();
        this.postAppInstallFunctions.forEach((installFunction)=>{
          promiseChain = promiseChain.then(()=> promiseFactory(installFunction));
        })

        return promiseChain
          .then(()=> {
            // update list of installed shops in memory
            let installedShops = handy.system.systemGlobal.get('installed_shops') || [];
            installedShops.push(this);
            return handy.system.systemGlobal.set('installed_shops', installedShops);
          });

      })
      .catch((err)=> Promise.reject(err))
  }


  // uninstall app from Shop
  uninstallApp(){
    this.installed = false;
    this.app_settings.webhooks = [];
    return this.save()
      .then(()=>{
        return new Promise((resolve, reject)=>{
          // remove shop from list of installed shops
          let installedShops = handy.system.systemGlobal.get('installed_shops') || [];
          let newInstalledShops = installedShops.filter((val)=>{
            return val.myshopify_domain !== this.myshopify_domain;
          })

          handy.system.systemGlobal.set('installed_shops', newInstalledShops);

          return resolve();
        })
      })
      .then(()=>{
        // end subscription
        return this.getSubscriptions({active: true})
          .then((activeSubscriptionArray)=>{
            if(!activeSubscriptionArray.length){return Promise.resolve();}  // no active subscriptions so stop processing
            let activeSubscription = activeSubscriptionArray[0];
            let currentSubscription = new Subscription(activeSubscription);
            return currentSubscription.load('id')
              .then(()=> currentSubscription.endSubscription())
          })
      })
  }


  // get current access scopes
  getAccessScopes(){
    return new Promise((resolve, reject)=>{
      const query = `
        query getAccessScopes {
          appInstallation {
            accessScopes {
              handle
            }
          }
        }
      `;

      this.ShopifyGQL()
        .send(JSON.stringify({query}))
        .then((res)=>{
          const errors = res.body.errors;
          if(errors && errors.length){
            let errorMessage = ''
            errors.map((error)=>{
              errorMessage += '; ' + error.message;
              return reject(new Error(errorMessage));
            })
          } else {
            const scopes = res.body.data.appInstallation.accessScopes;
            let returnScopes = [];
            scopes.forEach((scope)=>{
              returnScopes.push(scope.handle);
            })
            return resolve(returnScopes);
          }
        })
    })
  }



  // retrieve all orders
  getOrders(orderId=null, fulfillment_status='unfulfilled', stream=false, gql=false, fields=[]){
    if(!gql){
      this.createShopifyAPI();
    }
    if(!stream){
      return _getShopOrders.bind(this)({id: orderId, fulfillment_status, gql, fields})
    } else {
      const streamEvent = new EventEmiter();
      _getShopOrders.bind(this)({id: orderId, fulfillment_status, streamEvent, gql, fields});
      return streamEvent;
    }
    /*
        return new Promise((resolve, reject)=>{
          this.createShopifyAPI();
          _getShopOrders.bind(this)({id:orderId, fulfillment_status})
          .then((orders)=> resolve(orders))
          .catch(reject);
        })
    */
  }


  // update order
  updateOrder({orderId, order, gql=false}){
    return new Promise((resolve, reject)=>{
      if(gql){
        return reject(new Error('update order graphql api has not yet been implemented'))
      } else {
        this.createShopifyAPI();
        const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
        order.id = orderId;
        const payload = {order};
        this.Shopify.put(`/admin/api/${shopify_api_version}/orders/${orderId}.json`, payload, (err, data, headers)=>{
          if(err){return reject(new Error(`error updating order - ${err.message}`))}
          return resolve(data.order);
        })
      }
    })
  }


  // retrieve all products
  getProducts({fields=[], ids=[], handle=null, product_type=null, filter=null, stream=false, gql=false}){
    console.log('WARNING: handy-shopify/getProducts has not implemented variant fields for requests that specify ids or handle')
    if(!stream){
      return this._getProducts({fields, ids, handle, product_type, filter, gql});
    } else {
      const streamEvent = stream ? new EventEmiter() : null;
      this._getProducts({fields, ids, handle, product_type, filter, streamEvent, gql});
      return streamEvent;
    }
  }


  _getProducts({fields, ids, handle, product_type, filter=null, streamEvent=null, gql=false}){
    return new Promise((resolve, reject)=>{
      this.createShopifyAPI();
      _getShopProducts.bind(this)({fields, ids, handle, product_type, filter, streamEvent, gql})
        .then((products)=> resolve(products))
        .catch(reject);
    })
  }


  // add a product to the shop
  createProduct(productDefinition={}, fields=[], gql=false){
    return new Promise((resolve, reject)=>{
      if(gql){
        const defaultProductFields = ['id', 'productType', 'title', 'handle', 'description', 'vendor', 'totalInventory'];
        const returnFields = fields.length ? fields : defaultProductFields;
        const variantFieldPrefix = 'variant__';
        let variantFields = returnFields.filter(x => x.includes(variantFieldPrefix));
        variantFields = variantFields.map((x)=>{
          const regex = new RegExp(variantFieldPrefix, 'g');
          return x.replace(regex, '');
        })

        const productFields = returnFields.filter((x)=>{
          const isVariantField = x.includes(variantFieldPrefix);
          return !isVariantField;
        })

        const productFragment = `
          fragment returnedProductFields on Product {
            ${productFields.join(' ')}
          }
        `;

        const variantFragment = variantFields.length ? `
          fragment returnedVariantFields on ProductVariant {
            ${variantFields.join(' ')}
          }
        ` : '';

        const mutationPrefix = `
          mutation productCreate ($input: ProductInput!) {
            productCreate (input: $input) {
              product {
                ...returnedProductFields
                ${variantFields.length ? 'variants (first: 100) { edges { node { ...returnedVariantFields } } }' : ''}
              }

              userErrors {
                field
                message
              }
            }
          }
        `;

        const mutation = mutationPrefix + productFragment + variantFragment;
        const variables = {input: productDefinition};

        this.ShopifyGQL()
          .on('err', (err)=>{
            return reject(err);
          })
          .send(JSON.stringify({query:mutation, variables}))
          .then((res)=>{
            const returnedErrors = res.body.data.productCreate.userErrors;
            if(returnedErrors.length){
              let returnedErrorMessageArray = [];
              returnedErrors.forEach((returnedError)=>{
                returnedErrorMessageArray.push(returnedError.message);
              })
              const errorMessage = returnedErrorMessageArray.join('; ')
              return reject (new Error(errorMessage));
            }
            const product = res.body.data.productCreate.product;
            return resolve(product);
          })

      } else {
        this.createShopifyAPI();
        const payload = {product: productDefinition};
        const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
        this.Shopify.post('/admin/api/' + shopify_api_version + '/products.json', payload, (err, data, headers)=>{
          if(err){return reject(new Error('error creating new product - ' + err.message)); }
          const {product} = data;
          return resolve(product);
        })
      }

    })
  }


  // update a product in the shop
  updateProduct(productDefinition={}, productId){
    return new Promise((resolve, reject)=>{
      this.createShopifyAPI();
      const payload = {product: productDefinition};
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.Shopify.put('/admin/api/' + shopify_api_version + '/products/' + productId + '.json', payload, (err, data, headers)=>{
        if(err){return reject(new Error('error updating product - ' + err.message))}
        const {product} = data;
        return resolve(product);
      })
    })
  }


  // get details of a single product variant
  getProductVariant(id, fields=[], gql=false){
    return new Promise((resolve, reject)=>{
      if(!id){return reject(new Error('variant id required to request variant details'))}
      if(gql){
        const defaultVariantFields = ['id', 'title'];  // default fields that will be provided if none is specified
        const returnedVariantFields = fields.length ? fields : defaultVariantFields;
        const queryPrefix = `
          query getProductVariant ($id: ID!) {
            productVariant (id: $id) {
              ... productVariantFields
            }
          }
        `;

        const specialFields = ['inventoryItem'];  // fields that must be treated specially
        let normalFields = [];
        let expandFields = [];
        returnedVariantFields.forEach((returnedVariantField)=>{
          if(specialFields.includes(returnedVariantField)){
            expandFields.push(returnedVariantField);
          } else {
            normalFields.push(returnedVariantField);
          }
        })

        let fragmentFields = normalFields.join(' ');

        expandFields.forEach((expandField)=>{
          switch (expandField){
            case 'inventoryItem':
              fragmentFields += `
                inventoryItem {
                  id
                  inventoryLevels (first: 100) {
                    edges {
                      node {
                        id
                        available
                        location {
                          id
                          name
                          isActive
                          shipsInventory
                        }
                      }
                    }
                  }
                }
              `;
              break;
          }
        })

        const fragment = `
          fragment productVariantFields on ProductVariant {
            ${fragmentFields}
          }
        `;

        const query = queryPrefix + fragment;
        const variables = {id};

        this.ShopifyGQL()
          .send(JSON.stringify({query, variables}))
          .then((res)=>{
            const errors = res.body.errors;
            if(errors && errors.length){
              let errorMessage = ''
              errors.map((error)=>{
                errorMessage += '; ' + error.message;
                return reject(new Error(errorMessage));
              })
            } else {
              const variant = res.body.data.productVariant;
              return resolve(variant);
            }
          })

      } else {
        this.createShopifyAPI();
        const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
        this.Shopify.get('/admin/api/' + shopify_api_version + '/variants/' + id + '.json', (err, data, headers)=>{
          if(err){return reject(new Error('error retrieving variant details - ' + err.message))}
          const {variant} = data;
          return resolve(variant);
        })
      }
    })
  }


  // get variants from a shop
  getAllProductVariants({fields, filter, gql=false, stream=false}){
    return new Promise((resolve, reject)=>{
      if(gql){
        if(stream){
          const streamEvent = stream ? new EventEmiter() : null;
          _getAllProductVariants.bind(this)({fields, filter, streamEvent});
          return resolve(streamEvent);
        } else {
          // create recursive function to return all variants
          _getAllProductVariants.bind(this)({fields, filter})
            .then((variants)=> resolve(variants))
            .catch(err=> reject(err))
        }
      }
    })
  }


  // create product variant
  createProductVariant({variantDefinition={}, fields=[], gql=false}){
    if(gql){
      const defaultVariantFields = ['id', 'title'];  // default fields that will be provided if none is specified
      const variantFields = fields.length ? fields : defaultVariantFields;
      const fragment = `
        fragment variantFields on ProductVariant {
          ${variantFields.join(' ')}
        }
      `;

      const mutationPrefix = `
        mutation createProductVariant ($input: ProductVariantInput!){
          productVariantCreate(input: $input) {
            productVariant {
              ...variantFields
            }

            userErrors {
              message
              field
            }
          }
        }
      `;

      const mutation = mutationPrefix + fragment;
      const variables = {input: variantDefinition};

      return this.ShopifyGQL()
        .on('err', (err)=>{
          return Promise.reject(err);
        })
        .send(JSON.stringify({query: mutation, variables}))
        .then((res)=>{
          return new Promise((resolve, reject)=>{
            const returnedErrors = res.body.data.productVariantCreate.userErrors;
            if(returnedErrors.length){
              let returnedErrorMessageArray = [];
              returnedErrors.forEach((returnedError)=>{
                returnedErrorMessageArray.push(returnedError.message);
              })
              const errorMessage = returnedErrorMessageArray.join('; ')
              return reject (new Error(errorMessage));
            }

            const variant = res.body.data.productVariantCreate.productVariant;
            return resolve(variant);
          })
        })
    }
  }


  updateProductVariant({variantDefinition, fields, gql}){
    if(gql){
      const defaultVariantFields = ['id', 'title'];  // default fields that will be provided if none is specified
      const variantFields = fields.length ? fields : defaultVariantFields;
      const fragment = `
        fragment variantFields on ProductVariant {
          ${variantFields.join(' ')}
        }
      `;

      const mutationPrefix = `
        mutation updateProductVariant ($input: ProductVariantInput!){
          productVariantUpdate (input: $input) {
            productVariant {
              ...variantFields
            }

            userErrors {
              message
              field
            }
          }
        }
      `;

      const mutation = mutationPrefix + fragment;
      const variables = {input: variantDefinition};

      return this.ShopifyGQL()
        .on('err', (err)=>{
          return Promise.reject(err);
        })
        .send(JSON.stringify({query: mutation, variables}))
        .then((res)=>{
          return new Promise((resolve, reject)=>{
            const returnedErrors = res.body.data.productVariantUpdate.userErrors;
            if(returnedErrors.length){
              let returnedErrorMessageArray = [];
              returnedErrors.forEach((returnedError)=>{
                returnedErrorMessageArray.push(returnedError.message);
              })
              const errorMessage = returnedErrorMessageArray.join('; ')
              return reject (new Error(errorMessage));
            }

            const variant = res.body.data.productVariantUpdate.productVariant;
            return resolve(variant);
          })
        })
    }
  }


  // update shop Shopify settings
  updateShopShopifySettings(settings){
    if(!settings || typeof settings !== 'object' || _.isEmpty(settings)){return Promise.resolve(); }

    const excludedKeys= ['id', 'createdate', 'modifydate', 'deleted', 'nonce', 'access_token',
      'app_settings', 'installed', 'emulations', 'admin_notifications', 'tableDefinition'
    ];

    const includedKeys = ['shopify_store_id', 'shopify_gql_store_id', 'address1', 'address2', 'city', 'province',
      'province_code', 'zip', 'country_code', 'country', 'owner', 'email', 'phone',
      'domain', 'myshopify_domain', 'money_format', 'currency', 'shopify_plan',
      'shopify_created_at', 'shopify_updated_at'
    ];

    _.forEach(settings, (val, key)=>{
      if(excludedKeys.includes(key)){
        // do nothing if the key is not a shopify setting
      } else if(includedKeys.includes(key)){
        if(key === 'shopify_created_at' || key === 'shopify_updated_at'){
          this[key] = new Date(val);
        } else {
          this[key] = val;
        }

        if(key === 'money_format'){
          if(this[key].length > 64){this[key] = ''} // truncate money format entries that are too long
        }
      }
    })

    return this.save();
  }


  // update shop app settings
  updateShopSettings(settings){
    return new Promise((resolve, reject)=>{
      // settings must be an object
      if(!settings || typeof settings !== 'object' || _.isEmpty(settings)){return resolve(); }

      _.forEach(settings, (val, key)=>{
        this.app_settings[key] = val;
      }, this)

      this.save()
        .then(resolve)
        .catch(reject)
    })
  }


  // create a recurring charge (note this is the first step in billing a customer)
  createRecurringCharge(planName){
    let plan = new Plan({name: planName.toLowerCase()})
    return plan.load('name')
      .then(()=>{

        // if plan price is 0, then remove any existing charges from shop
        if(plan.price === 0){
          return this.removeRecurringCharges(plan);
        }

        return new Promise((resolve, reject)=>{
          const query = `
            query getShopDetails {
              shop {
                plan {
                  displayName
                }
              }
            }
          `;

          this.ShopifyGQL()
            .on('err', (err)=>{
              return reject(err);
            })
            .send(JSON.stringify({query}))
            .then((res)=> {
              const returnedShop = res.body.data.shop;
              const test = TEST_PLANS[returnedShop.plan.displayName] || false;

              const variables = {
                name: plan.name,
                trialDays: plan.trial_length,
//          returnUrl: `https://${this.myshopify_domain}/admin/apps/${handy.system.systemGlobal.getConfig('shopify_api_key')}`,
                returnUrl: `${handy.system.systemGlobal.get('billing_charge_activation_redirect_url')}?shop=${encodeURIComponent(this.myshopify_domain)}&billing_plan=${encodeURIComponent(plan.name)}${test ? '&test_flag=true' : ''}`,
                test,
                lineItems: [
                  {
                    plan: {
                      appRecurringPricingDetails: {
                        price: {
                          amount: plan.price,
                          currencyCode: 'USD'
                        }
                      }
                    }
                  }
                ]
              };

              const mutation = `
                mutation appSubscriptionCreate ($name: String!, $trialDays: Int!, $test: Boolean!,  $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!) {
                  appSubscriptionCreate (name: $name, trialDays: $trialDays, test: $test, lineItems: $lineItems, returnUrl: $returnUrl) {
                    appSubscription {
                      id
                    }
      
                    confirmationUrl 
                    userErrors {
                      field
                      message
                    }
                  }
                }
              `;
                this.ShopifyGQL()
                  .on('err', (err)=>{
                    return reject(err);
                  })
                  .send(JSON.stringify({query: mutation, variables}))
                  .then((res)=>{
                    const returnedErrors = res.body.data.appSubscriptionCreate.userErrors;
                    if(returnedErrors.length){
                      let returnedErrorMessageArray = [];
                      returnedErrors.forEach((returnedError)=>{
                        returnedErrorMessageArray.push(returnedError.message);
                      })
                      const errorMessage = returnedErrorMessageArray.join('; ')
                      return reject (new Error(errorMessage));
                    }

                    const confirmation_url = res.body.data.appSubscriptionCreate.confirmationUrl;
                    return resolve(confirmation_url);
                  })
              })
            });
      })
      .catch((err)=> Promise.reject(err))
  }


  // remove any existing recurring charges
  removeRecurringCharges(plan){
    // get all recurring charges
    // delete all charges with status 'active' or 'frozen'

    const query = `
      query getAllActiveCharges {
        currentAppInstallation {
          activeSubscriptions {
            id
            status
          }
        }
      }
    `;

    return this.ShopifyGQL()
      .send({query})
      .then((res)=>{
        const activeSubscriptions = res.body.data.currentAppInstallation.activeSubscriptions;

        const promiseFactory = (subscription)=>{
          return new Promise((resolve, reject)=>{
            const mutation = `
            mutation cancelSubscription ($id: ID!) {
              appSubscriptionCancel (id: $id) {
                appSubscription {
                  id
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `;

            const variables = {
              id: subscription.id
            }

            return this.ShopifyGQL()
              .on('err', (err)=>{
                return reject(err);
              })
              .send(JSON.stringify({query: mutation, variables}))
              .then((res)=>{
                const returnedErrors = res.body.data.appSubscriptionCancel.userErrors;
                if(returnedErrors.length){
                  let returnedErrorMessageArray = [];
                  returnedErrors.forEach((returnedError)=>{
                    returnedErrorMessageArray.push(returnedError.message);
                  })
                  const errorMessage = returnedErrorMessageArray.join('; ')
                  return reject (new Error(errorMessage));
                }

                return resolve()
              })
          })
        }

        let promiseChain = Promise.resolve();
        activeSubscriptions.forEach((subscription)=>{
          const activeSubscriptionStatus = ['ACCEPTED', 'ACTIVE', 'FROZEN'];
          if(activeSubscriptionStatus.includes(subscription.status.toUpperCase())){
            promiseChain = promiseChain.then(()=> promiseFactory(subscription))
          }
        })

        return promiseChain
          .then(()=> this.updateSubscription(plan.id))
      })
    /*
        const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');

        return new Promise((resolve, reject)=>{
          this.createShopifyAPI();
          this.Shopify.get('/admin/api/' + shopify_api_version + '/recurring_application_charges.json', (err, data, headers)=>{
            if(err){return reject(new Error('error getting existing recurring application charges from Shopify -\n' + JSON.stringify(err)))}
            const {recurring_application_charges} = data;

            const promiseFactory = (charge)=>{
              return new Promise((resolve1, reject1)=>{
                const validPlanStatus = ['active', 'frozen'];  // status of charges to be removed
                if(!validPlanStatus.includes(charge.status)){ return resolve1(); }
                this.Shopify.delete('/admin/api/' + shopify_api_version + '/recurring_application_charges/' + charge.id + '.json', (err1, data1, headers1)=>{
                  if(err1){return reject1(new Error('error deleting existing recurring application charge: ' + charge.id + ' -\n', JSON.stringify(err1)))}
                  return resolve1();
                })
              })
            }

            let promiseChain = Promise.resolve();

            recurring_application_charges.forEach((charge)=>{
              promiseChain = promiseChain.then(()=> promiseFactory(charge))
            })

            return promiseChain
            .then(()=> resolve());
          })
        })
        .then(()=> this.updateSubscription(plan.id))
    */
  }


  activateCharge({charge_id, billing_plan, test_flag=false}){
    const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
    if(!charge_id || !billing_plan){
      return Promise.reject(new Error('activateCharge: charge id or billing plan name must be provided '));
    }

    this.createShopifyAPI();
    // load plan
    const plan = new Plan({name: billing_plan})
    return plan.load('name')
      .then(generateInternalUrlRequestHash)
      .then((handy_shopify_url_validation_hash)=>{
        return new Promise((resolve, reject)=>{
          /*
                  const active_tag = 'settings';
                  const shop = this.myshopify_domain;
                  const query = {active_tag, handy_shopify_url_validation_hash, shop};

                  let queryStringArray = [];
                  _.forEach(query, (val, key)=>{
                    queryStringArray.push(key + '=' + val);
                  })

                  const queryString = queryStringArray.join('&');
                  const redirectDestination = handy.system.systemGlobal.getConfig('siteURL') + '/handy/shopify/admin?' + queryString;
          */
          const redirectDestination = `https://${this.myshopify_domain}/admin/apps/${handy.system.systemGlobal.getConfig('shopify_api_key')}`

          const payload = {
            recurring_application_charge: {
              id: charge_id,
              name: plan.name,
              price: plan.price,
              test: test_flag ? true : null,
              trial_days: plan.trial_length,
              return_url: redirectDestination
            }
          }

          this.Shopify.post('/admin/api/' + shopify_api_version + '/recurring_application_charges/' + charge_id + '/activate.json', payload, (err, data, headers)=>{
            const status = !err ? data.recurring_application_charge.status : 'declined' ;
            let message, message_type, redirect_url;
            if(status !== 'active'){
              // charge is not activated
              message = encodeURIComponent('charge not activated.  please try again');
              message_type = encodeURIComponent('error')
              redirect_url = redirectDestination + '&message=' + message + '&message_type=' + message_type;
              return resolve({redirect_url, status});
            }

            // plan is activated so update subscription
            this.updateSubscription(plan.id)
              .then(()=>{
                message = encodeURIComponent('billing plan successfully activated');
                message_type = encodeURIComponent('notice');
                redirect_url = redirectDestination + '?message=' + message + '&message_type=' + message_type;
                return resolve({redirect_url, status});
              })
              .catch((err)=> reject(err))
            /*
                      // plan is activated so update billing plan
                      this.billing_plan = plan.id;
                      message = encodeURIComponent('billing plan successfully activated');
                      message_type = encodeURIComponent('notice');
                      redirect_url = redirectDestination + '&message=' + message + '&message_type=' + message_type;
                      this.save()
                      .then(()=> resolve({redirect_url, status}))
                      .catch(reject)
            */
          })
        })
      })
      .catch((err)=> Promise.reject(err))
  }


  // get list of existing webhooks
  getWebhooks(){
    return new Promise((resolve, reject)=>{
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.createShopifyAPI();
      this.Shopify.get('/admin/api/' + shopify_api_version + '/webhooks.json', (err, data, headers)=>{
        if(err){return reject (new Error('error getting webhooks list from Shopify -\n', + err.message)); }
        return resolve(data.webhooks);
      })
    })
  }


  // reset webhooks
  resetWebhooks(){
    return new Promise((resolve, reject)=>{
      // each shop should have a list of all installed webhooks, if not (for legacy reasons)
      // create an empty list
      this.app_settings.webhooks = this.app_settings.webhooks || [];

      // check if project has defined the default webhooks.
      // NOTE: this global may not exist.  It is only inlcuded
      // for backwards compatibility with older projects
      const shopify_default_webhooks = handy.system.systemGlobal.get('shopify_default_webhooks');
      const handy_shopify_default_webhooks = handy.system.systemGlobal.get('handy_shopify_default_webhooks');

      // check if the shopify_default_webhooks global is defined
      if (Array.isArray(shopify_default_webhooks) && Array.isArray(handy_shopify_default_webhooks)){
        // if the shopify_default_webhooks global exists, then check if the shop.app_settings.webhooks
        // should be updated

        const compareWebhooks = shopify_default_webhooks.concat(handy_shopify_default_webhooks);
        if(compareWebhooks.length > this.app_settings.webhooks.length){
          // replace current app_settings.webhook with global default
          this.app_settings.webhooks = compareWebhooks;
          this.save()
            .then(()=> resolve())
            .catch((err)=> reject(err))
        } else {
          return resolve();
        }
      } else {
        return resolve();
      }
    })
      .then(()=>{
        return new Promise((resolve, reject)=>{
          // get current webhooks attached to shop and check which, if any, are missing
          this.getWebhooks()
            .then((currentWebhooks)=>{
              let missingWebhooks = [];
              this.app_settings.webhooks.forEach((webhook)=>{
                let isWebhookMissing = true;
                currentWebhooks.forEach((currentWebhook)=>{
                  if(currentWebhook.topic === webhook.webhook.topic && currentWebhook.address === webhook.webhook.address){
                    isWebhookMissing = false;
                  }
                })

                isWebhookMissing ? missingWebhooks.push(webhook) : null;
              })

              return resolve(missingWebhooks);
            })
        })
      })
      .then((missingWebhooks)=>{
        return new Promise((resolve, reject)=>{
          let alert
            , msg
            , err
          ;

          // end processing if no missing webhooks
          if(missingWebhooks.length === 0){
            alert = {type: 'info', text: 'webhooks update skipped.  webhooks already up to date'};
            msg = 'shop webhook update skipped';
            return resolve({alert, msg});
          }

          createWebhooks.bind(this)(missingWebhooks)
            .then(()=>{
              alert = {type: 'success', text: 'webhooks successfully updated'};
              msg: 'shop webhook successfully updated';
              return resolve({alert, msg});
            })
            .catch((err)=>{
              return reject(new Error('error updating shop webhooks - ' + err.message));
            })

        })
      })
      .catch((err)=> Promise.reject(err))
  }

  // remove script tags
  removeScriptTags(){
    const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version')
    // get all script tags
    return new Promise((resolve, reject) => {
      this.createShopifyAPI()
      this.Shopify.get('/admin/api/' + shopify_api_version + '/script_tags.json', (err, data, headers) => {
        if (err) {
          return reject(err)
        }
        return resolve(data.script_tags)
      })
    })
      .then(script_tags => {
        // remove all current script tags
        const promiseFactory = tagId => {
          return new Promise((resolve, reject) => {
            this.Shopify.delete('/admin/api/' + shopify_api_version + '/script_tags/' + tagId + '.json', (err, data, headers) => {
              if (err) {
                return reject(new Error('resetScriptTags: error removing script tag - id: ' + tagId + ' - err: ' + JSON.stringify(err)))
              }
              return resolve()
            })
          })
        }

        let promiseChain = Promise.resolve()
        script_tags.forEach(tag => {
          promiseChain = promiseChain.then(() => promiseFactory(tag.id))
        })

        return promiseChain
      })
  }

  // reinstall script tags and update the version tag
  resetScriptTags(){
    this
      .removeScriptTags()
      .then(()=>{
        // add new script tags
        const new_script_tags = handy.system.systemGlobal.get('default_script_tags') || [];
        return createScriptTags.bind(this)(new_script_tags);
      })
      .then(()=>{
        const alert = {type: 'success', text: 'script tags successfully updated'};
        const msg = 'script tags successfully updated';
        return Promise.resolve({alert, msg});
      })
      .catch((err)=> Promise.reject(new Error('error updating script tags - ' + err.message)))
  }


  // retrieve all customers
  getCustomers({fields=[], ids=[], stream=false, gql=false}){
    return new Promise((resolve, reject)=>{
      if(gql){
        if(stream){
          const streamEvent = stream ? new EventEmiter() : null;
          _getShopCustomers.bind(this)({fields, ids, streamEvent, gql})
            .then(()=> resolve(streamEvent))
        } else {
          _getShopCustomers.bind(this)({fields, ids, gql})
            .then((customers)=> resolve(customers))
            .catch(err => reject(err))
        }
      } else {
        this.createShopifyAPI();
        _getShopCustomers.bind(this)({fields, ids})
          .then((customers)=> resolve(customers))
          .catch(err => reject(err));
      }
    })
  }


  // update customer account
  updateCustomer(customer, gql){
    return new Promise((resolve, reject)=>{
      if(gql){
        const mutation = `
          mutation updateCustomer ($input: CustomerInput!){
            customerUpdate(input: $input) {
              customer {
                id
              }

              userErrors {
                field
                message
              }
            }
          }
        `;

        const variables = {input: customer};

        this.ShopifyGQL()
          .on('err', (err)=>{
            return reject(err);
          })
          .send(JSON.stringify({query: mutation, variables}))
          .then((res)=>{
            const returnedErrors = res.body.data.customerUpdate.userErrors;
            if(returnedErrors.length){
              let returnedErrorMessageArray = [];
              returnedErrors.forEach((returnedError)=>{
                returnedErrorMessageArray.push(returnedError.message);
              })
              const errorMessage = returnedErrorMessageArray.join('; ')
              return reject (new Error(errorMessage));
            }

            resolve(res.body.data.customerUpdate.customer.id)
          })

      } else {
        const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
        this.createShopifyAPI();
        this.Shopify.put('/admin/api/' + shopify_api_version + '/customers/' + customer.customer.id + '.json', customer, (err, data, headers)=>{
          if(err){return reject(err); }
          return resolve(data.customer);
        })
      }
    })
  }

  /*
   * create a notification to be displayed in the app admin
   * @params {string} type - options 'dismissable' or 'snoozeable'
   *            dismissable - means the message can be dismissed one time
   *            snoozeable - message can be snoozed
   * @params {string} style - options 'header', 'text', 'list'
   *            header - displayed with emphasis
   *            text - displayed normally
   *            list - expects array of strings in text parameter
   * @params {Date} displayAfter - earliest date to display notification
   * @params {string or array} text - notification text for display or array of text if style is 'list'
   *
  */

  createAdminNotification({type='dismissable', style='text', displayAfter=Date.now(), text, id=uuidv4()}){
    this.admin_notifications[type].push({style, displayAfter, text, id});
    return this.save();
  }


  // dismiss or snooze a notification (cancelType = 'dismiss/snooze', default snooze is 3 days)
  cancelAdminNotification({cancelType='dismiss', ids, delay=3*24*60*60*1000}){
    // convert ids to array if string sent
    ids = Array.isArray(ids) ? ids : ids.split(',');

    let now = Date.now();

    // locate notification for each id
    ids.forEach((id)=>{
      Object.keys(this.admin_notifications).forEach((dismissType)=>{
        this.admin_notifications[dismissType].forEach((message, messageKey)=>{
          if(message.id === id){
            if(cancelType === 'dismiss'){
              this.admin_notifications[dismissType].splice(messageKey, 1);
            }

            if(cancelType === 'snooze'){
              this.admin_notifications[dismissType][messageKey].displayAfter = now + delay;
            }
          }
        })
      })
    })

    return this.save();
  }


  // update shop subscription ie end existing subscription and start new one with specified plan
  updateSubscription(plan){
    // if there is a current subscription, end it

    return this.getSubscriptions({active: true})
      .then((activeSubscriptionArray)=>{
        // check if any subscription is active
        let activeSubscription = activeSubscriptionArray[0] || {};
        if(activeSubscription.active){
          let oldSubscription = new Subscription(activeSubscription);
          return oldSubscription.load('id')
            .then(()=> oldSubscription.endSubscription())
        } else {
          return Promise.resolve();
        }
      })
      .then(()=>{
        // set to default plan if none provided
        plan = (plan === undefined || plan === null) ? handy.system.systemGlobal.getConfig('shopify_app_billing_plan_default') : plan;
        // start a new subscription
        let newSubscription = new Subscription({billing_plan: plan, shop: this.id});
        return newSubscription.startNewSubscription()
      })
  }


  // get subscriptions.  return only the active subscription if active flag is set
  getSubscriptions({active=true}={}){
    return new Promise((resolve, reject)=>{
      const pool = handy.system.systemGlobal.get('pool');
      pool.getConnection((err, connection)=>{
        if(err){return reject(err); }
        let query = 'SELECT * FROM subscriptions WHERE shop=' + connection.escape(this.id);
        query += active ? ' AND active=true LIMIT 1' : '';

        connection.query(query, (err, results)=>{
          connection.release();
          if(err){return reject(err); }
          let subscriptions = [];
          results.forEach((subscription)=>{
            subscriptions.push(subscription);
          })

          return resolve(subscriptions);
        })
      })
    })
  }


  // get billing plan attached to current subscription
  getBillingPlan(){
    return this.getSubscriptions({active:true})
      .then((activeSubscriptionArray)=>{

        const activeSubscription = activeSubscriptionArray[0];
        // if no active subscription, return a dummy billing plan ie 0
//      if(!activeSubscription || !activeSubscription.billing_plan){
        if(!activeSubscription){
          const dummyPlan = {id: null, name: null, price: null, term: null, test: null, trial_length: null};
          return Promise.resolve(dummyPlan);
        } else {
          let currentPlan = new Plan({id: activeSubscription.billing_plan});
          return currentPlan.load('id')
            .then(()=> Promise.resolve(currentPlan))
        }
      })
      .catch((err)=> Promise.reject(err))
  }


  // get list of locations available in the shop
  getLocations({ids=[], legacy='all', active='all', saved=false}){
    return new Promise((resolve, reject)=>{
      if(saved){
        // get the locations from the database
        const pool = handy.system.systemGlobal.get('pool');
        pool.getConnection((err, connection)=>{
          if(err){return reject(new Error('error getting database connection - ' + err.message))}
          let queryQualifierArray = [];
          ids.forEach((id)=>{
            queryQualifierArray.push('shopify_location_id=' + connection.escape(id));
          })

          if(legacy !== 'all'){
            queryQualifierArray.push('legacy=' + connection.escape(legacy));
          }

          if(active !== 'all'){
            queryQualifierArray.push('active=' + connection.escape(active));
          }

          let queryQualifier = '';
          if(queryQualifierArray.length){
            queryQualifier += ' WHERE ' + queryQualifierArray.join(' AND ');
          }

          let query = 'SELECT * FROM locations' + queryQualifier;
          connection.query(query, (err, results)=>{
            if(err){return reject(new Error('error querying location data from database - ' + err.message))}
            return resolve(results);
          })
        })
      } else {
        // get locations from shopify
        this.createShopifyAPI();
        _getShopLocations.bind(this)({ids, legacy, active})
          .then((locations)=> resolve(locations))
          .catch(reject);
      }
    })
  }


  // get inventory for a given location
  getLocationInventory(locationId, inventory_item_ids='all', limit=250){
    return new Promise((resolve, reject)=>{
      const max_number_of_locations = 50;  // maximum number of locations that can be checked at once
      const max_number_of_inventory_ids = 50;  // maximum number of items that can be specified in an inventory check

      if(!locationId){return reject(new Error('please provide at least one location id'))}
      // if locationId is an array, convert to string
      if(Array.isArray(locationId)){
        if(locationId.length > max_number_of_locations){
          return reject(new Error('cannot request inventory for more than ' + max_number_of_locations + ' locations'));
        }
        locationId = locationId.join(',');
      }

      // if inventory_item_ids is an array, convert to string
      if(Array.isArray(inventory_item_ids)){
        if(inventory_item_ids.length > max_number_of_inventory_ids){
          return reject(new Error('cannot request inventory for more than ' + max_number_of_inventory_ids + ' items'));
        }
        inventory_item_ids = inventory_item_ids.join(',');
      }

      // if inventory_item_ids is default ('all'), then set to null
      if(inventory_item_ids === 'all'){
        inventory_item_ids = null;
      }

      this.createShopifyAPI();
      _getLocationInventory.bind(this)({locationId, inventory_item_ids, limit})
        .then((inventory_levels)=> resolve(inventory_levels))
        .catch((err)=> reject(err));
    })
  }


  // add or remove inventory from location
  adjustLocationInventory({location_id, inventory_item_id, available_adjustment}){
    return new Promise((resolve, reject)=>{
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.createShopifyAPI();
      const payload = {location_id, inventory_item_id, available_adjustment};

      this.Shopify.post('/admin/api/' + shopify_api_version + '/inventory_levels/adjust.json', payload, (err, data, headers)=>{
        if(err){return reject(new Error('error adjusting Shopify location inventory - ' + JSON.stringify(err.errors)))}
        return resolve();
      })
    })
  }


  // add or remove product variant inventory
  adjustVariantInventory({variant_id, available_adjustment}) {
    // get inventory item for variant
    const fields = ['id', 'inventoryItem'];
    const gql = true;
    return this.getProductVariant(variant_id, fields, gql)
      .then((productVariant)=>{
        return new Promise((resolve, reject)=>{
          const inventoryItemId = productVariant.inventoryItem.id;
          const inventoryLevels = productVariant.inventoryItem.inventoryLevels.edges;
          let firstActiveInventoryLevel;
          let firstActiveInventoryLevelFound = false;
          inventoryLevels.forEach((node)=>{
            const level = node.node;
            if(level.location.isActive && level.location.shipsInventory && !firstActiveInventoryLevelFound){
              firstActiveInventoryLevel = level;
              firstActiveInventoryLevelFound = true;
            }
          })

          const mutation = `
          mutation inventoryAdjustQuantity ($input: InventoryAdjustQuantityInput!){
            inventoryAdjustQuantity(input: $input) {
              inventoryLevel {
                id
              }

              userErrors {
                field
                message
              }
            }
          }
        `;

          const InventoryAdjustQuantityInput = {
            inventoryLevelId: firstActiveInventoryLevel.id,
            availableDelta: available_adjustment
          }
          const variables = {input: InventoryAdjustQuantityInput};

          this.ShopifyGQL()
            .on('err', (err)=>{
              return reject(err);
            })
            .send(JSON.stringify({query: mutation, variables}))
            .then((res)=>{
              const returnedErrors = res.body.data.inventoryAdjustQuantity.userErrors;
              if(returnedErrors.length){
                let returnedErrorMessageArray = [];
                returnedErrors.forEach((returnedError)=>{
                  returnedErrorMessageArray.push(returnedError.message);
                })
                const errorMessage = returnedErrorMessageArray.join('; ')
                return reject (new Error(errorMessage));
              }

              resolve(res.body.data.inventoryAdjustQuantity.inventoryLevel.id)
            })
        })
      })
  }


  // register a carrier service
  registerCarrierService(carrierService){
    return new Promise((resolve, reject)=>{
      if(!carrierService){return reject(new Error('please provide a carrier service definition'))}
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.createShopifyAPI();
      this.Shopify.post('/admin/api/' + shopify_api_version + '/carrier_services.json', carrierService, (err, data, headers)=>{
        if(err){return reject(new Error(JSON.stringify(err)))}
        return resolve();
      })
    })
  }


  // get the current theme
  getThemes({current=false}){
    return new Promise((resolve, reject)=>{
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.createShopifyAPI();
      this.Shopify.get('/admin/api/' + shopify_api_version + '/themes.json', (err, data, headers)=>{
        if(err){return reject(new Error(JSON.stringify(err)))}
        if(!current){
          return resolve(data.themes);
        } else {
          // get the current theme
          let currentTheme = data.themes.filter((theme)=>{
            return (theme.role === 'main') ? true : false;
          })

          return resolve(currentTheme[0]);
        }
      })
    })
  }


  /**
   * @return {Promise<{state: boolean, themeId: number}>} where "state" is wheather 2.0 theme or not
   */
  getAppBlocksInfo() {
    return new Promise(async (resolve, reject) => {

      function parseSafeJSON(str) {
        let parsed

        try {
          parsed = JSON.parse(str)
        } catch(e) {
          try {
            parsed = JSON.parse(JSON.stringify(str))
          } catch(e) {
            return null
          }
        }

        return parsed
      }

      // const themeId = await getMainThemeId(shop)
      const theme = await this.getThemes({ current: true })
      const themeId = theme.id
      const assets = await this.getAssets(themeId)

      // Specify the name of the template the app will integrate with
      const APP_BLOCK_TEMPLATES = ['product', 'collection', 'index', 'cart']

      // Check if JSON template files exist for the template specified in APP_BLOCK_TEMPLATES
      const templateJSONFiles = assets.filter(file => APP_BLOCK_TEMPLATES.some(template => file.key === `templates/${template}.json`))

      // Retrieve the body of JSON templates and find what section is set as `main`
      const templateMainSections = (await Promise.all(
        templateJSONFiles.map(async (file, index) => {
          const asset = await this.getAsset(file.key, themeId)
          if (asset && asset.value) {
            try {
              const json = JSON.parse(asset.value)
              const main = Object.entries(json.sections).find(([id, section]) => id === 'main' || section.type.startsWith('main-'))
              if (main) {
                return assets.find(file => file.key === `sections/${main[1].type}.liquid`)
              }
            } catch(e) {
              console.error('err', e)
            }
          }
        }),
      )).filter((value) => value)


      // Request the content of each section and check if it has a schema that contains a
      // block of type '@app'
      const sectionsWithAppBlock = (await Promise.all(
        templateMainSections.map(async (file, index) => {
          let acceptsAppBlock = false
          const asset = await this.getAsset(file.key, themeId)
          if (asset && asset.value) {
            const match = asset.value.match(/\{\%\s+schema\s+\%\}([\s\S]*?)\{\%\s+endschema\s+\%\}/m)
            if (match && Array.isArray(match) && match.length > 1) {
              const matchString = match[1]
                .replace(/"/g, '"')
                .replace(/"/g, '"')
              const schema = parseSafeJSON(matchString)
              if (schema && schema.blocks) {
                acceptsAppBlock = schema.blocks.some((b) => b.type === '@app')
              }
              return acceptsAppBlock ? file : null
            } else {
              return null
            }
          }
          return null
        }),
      )).filter((value) => value)

      const state = sectionsWithAppBlock.length > 0

      resolve({ state, themeId })
    })
  }



  createAsset(asset, themeId){
    return new Promise((resolve, reject)=>{
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.createShopifyAPI();
      this.Shopify.put('/admin/api/' + shopify_api_version + '/themes/' + themeId + '/assets.json', asset, (err, data, headers)=>{
        if(err){return reject(new Error(err))}
        return resolve(data.asset);
      })
    })
  }


  getAssets(themeId){
    return new Promise((resolve, reject) => {
      console.log('getAssets...')
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version')
      this.createShopifyAPI()
      this.Shopify.get(`/admin/api/${shopify_api_version}/themes/${themeId}/assets.json`, (err, data, headers) => {
        if (err) {
          return reject(new Error(err.error))
        }
        return resolve(data.assets)
      })
    })
  }


  getAsset(key, themeId){
    return new Promise((resolve, reject)=>{
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.createShopifyAPI();
      this.Shopify.get(`/admin/api/${shopify_api_version}/themes/${themeId}/assets.json?asset[key]=${key}`, (err, data, headers)=>{
        if(err){
          if(err.error === 'Not Found'){
            return resolve({});
          } else {
            return reject(new Error(err.error))
          }
        }
        return resolve(data.asset);
      })
    })
  }


  getFulfillmentOrders(orderId){
    return new Promise((resolve, reject)=>{
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.createShopifyAPI();
      this.Shopify.get('/admin/api/' + shopify_api_version + '/orders/' + orderId + '/fulfillment_orders.json', (err, data, headers)=>{
        if(err){return reject(new Error(JSON.stringify(err)))}
        return resolve(data.fulfillment_orders);
      })
    })
  }

}

exports.Shop = Shop;


function _getShopOrders({id=null, fulfillment_status='unfulfilled', orders=[], streamEvent, gql, status='open', link=null}){
  return new Promise((resolve, reject)=>{
    if(!gql){
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      if(!id){
        const limit = 250;
        let query = {status, limit, fulfillment_status};
        let queryStringArray = [];
        _.forEach(query, (val, key)=>{
          queryStringArray.push(key + '=' + val);
        })

        const queryString = link ? link : '?' + queryStringArray.join('&');
        this.Shopify.get('/admin/api/' + shopify_api_version + '/orders.json' + queryString, (err, data, headers)=>{
          if(err){
            const error = new Error(`error getting orders from Shopify - ${err.message}`);
            streamEvent ? streamEvent.emit('error', error.message) : null;
            return reject(error);
          }
          orders = orders.concat(data.orders);

          // check if there are could be a next page or orders yet to be retrieved
          let rel;
          ({link, rel} =  _checkNextPage(headers));

          if(rel === 'next' && link){
            streamEvent ? streamEvent.emit('data', data.orders) : null;
            return resolve(_getShopOrders.bind(this)({orders, link}))
          } else {
            streamEvent ? streamEvent.emit('data', data.orders) : null;
            streamEvent ? streamEvent.emit('end') : null;
            orders.reverse();
            return resolve(orders);
          }
        })
      } else {
        // retrieving a specific order
        this.Shopify.get('/admin/api/' + shopify_api_version + '/orders/' + id + '.json', (err, data, headers)=>{
          if(err){return reject(new Error('error getting specific order from Shopify - \n' + JSON.stringify(err.error))); }
          return resolve(data.order);
        })
      }
    } else {
      const defaultOrderFields = ['id', 'name', 'displayFulfillmentStatus', 'displayFinancialStatus', 'displayAddress']
      const fetchedFields = fields.length ? fields : defaultOrderFields;
      const customerFieldPrefix = 'customer__';
      let customerFields = fetchedFields.filter(x => x.includes(customerFieldPrefix));
      customerFields = customerFields.map((x)=>{
        const regex = new RegExp(customerFieldPrefix, 'g');
        return x.replace(regex, '');
      })

      const lineItemFieldPrefix = 'line_items__';
      let lineItemFields = fetchedFields.filter(x => x.includes(lineItemFieldPrefix));
      lineItemFields = lineItemFields.map((x)=>{
        const regex = new RegExp('lineItemFieldPrefix', 'g');
        return x.replace(regex, '');
      })

      const orderFields = fetchedFields.filter((x)=>{
        const isOrderField = x.includes(customerFieldPrefix);
        const isLineItemField = x.includes(lineItemFieldPrefix);
        return !(isOrderField || isLineItemField);
      })

      // if customer fields or line item fields are requested, then get orders in batches of 5 only
      const first = customerFields.length + lineItemFields.length ? 5 : 250;

      const orderFragment = `
        fragment orderFields on Order {
          ${orderFields.join(' ')}
        }
      `;

      const customerFragment =  customerFields.length ? `
        fragment customerFields on Customer {
          ${customerFields.join(' ')}
        }
      ` : '';

      const lineItemFragment = lineItemFields.length ? `
        lineItems (first: 100) {
          edges {
            node {
              ${lineItemFields.join(' ')}
            }
          }
        }
      ` : '';


      const queryPrefix = `
        query getAllOrders ($first: Int!, $query: String, $cursor: String){
          orders (first: $first, query: $query, after: $cursor) {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor {
                node {
                  ...orderFields
                  ...customerFields
                  ${lineItemFields.length ? lineItemFragment : ''}
                }
              }
            }
          }
        }
      `;

      let query = `status:${status}`;
      if(fulfillment_status){
        query += `,fulfillment_status:${fulfillment_status}`
      }

      const variables = {first, query, cursor};
      const fullQuery = queryPrefix + orderFragment + customerFragment;

      this.ShopifyGQL()
        .on('err', (err)=>{
          streamEvent ? streamEvent.emit('error', err.message) : null;
          return reject(err);
        })
        .send(JSON.stringify({query: fullQuery, variables}))
        .then((res)=>{
          const edges = res.body.data.orders.edges;
          cursor = edges.length ? edges[edges.length-1].cursor : null;  // set cursor to last node
          let returnedOrders = [];
          edges.forEach((edge)=>{
            returnedOrders.push(edge.node);
          })

          // filter orders by id if required
          id ? returnedOrders.filter(x => x.id === id) : null;

          // if using the streaming api, stream output
          streamEvent ? streamEvent.emit('data', returnedOrders) : null;

          // update orders list
          orders = orders.concat(returnedOrders);

          // if there are no more pages, return the result
          const hasNextPage = res.body.data.orders.pageInfo.hasNextPage;

          if(hasNextPage){
            // recurse
            return resolve(_getShopOrders.bind(this)({id, fulfillment_status, orders, streamEvent, gql, }))
          } else {
            return resolve(orders);
          }
        })
    }
  })
}


/*
 * recursive function to retrieve products from shop
 * if argument link is provided, it overrides all other arguments
 * NOTE: Requires Shopify API version 2019-07 or higher
 */
function _getShopProducts({ids=[], fields=[], handle=null, product_type=null, filter=null, streamEvent=null, gql=false, products=[], link=null}){
  return new Promise((resolve, reject)=>{
    if(gql){
      const defaultProductFields = ['availablePublicationCount', 'createdAt', 'description', 'descriptionHtml', 'giftCardTemplateSuffix',
        'handle', 'hasOnlyDefaultVariant', 'hasOnlyDefaultVariant', 'id', 'isGiftCard', 'legacyResourceId', 'onlineStorePreviewUrl',
        'onlineStoreUrl', 'productType', 'publishedAt', 'seo', 'storefrontId', 'tags', 'templateSuffix', 'title', 'totalInventory',
        'totalVariants', 'tracksInventory', 'updatedAt', 'vendor'
      ];

      if(ids.length){
        return _getShopProductsByIdentifier.bind(this)({identifier: 'id', defaultProductFields, ids, fields, handle, product_type, streamEvent})
          .then((products)=> resolve(products))
          .catch((err)=> reject(err))
      } else if(handle){
        return _getShopProductsByIdentifier.bind(this)({identifier: 'handle', defaultProductFields, ids, fields, handle, product_type, streamEvent})
          .then((products)=> resolve(products))
          .catch((err)=> reject(err))
      } else {
        return _getAllShopProducts.bind(this)({defaultProductFields, fields, product_type, filter, streamEvent})
          .then((products)=> resolve(products))
          .catch((err)=> reject(err))
      }

    } else {
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      let queryStringArray = [];

      const limit = 250;  // request 250 items
      queryStringArray.push('limit=' + limit);

      if(ids.length){
        queryStringArray.push('ids=' + ids.join(','))
      }

      if(fields.length){
        queryStringArray.push('fields=' + fields.join(','))
      }

      if(handle !== null){
        queryStringArray.push('handle=' + handle);
      }

      if(product_type !== null){
        queryStringArray.push('product_type=' + product_type)
      }

      const query = link ? link : '?' + queryStringArray.join('&');
      this.Shopify.get('/admin/api/' + shopify_api_version + '/products.json' + query, (err, data, headers)=>{
        if(err){
          const error = new Error(`error getting products from Shopify - ${err.message}`);
          streamEvent ? streamEvent.emit('error', error.message) : null;
          return reject(error);
        }
        products = products.concat(data.products);  // append the returned products to the existing list

        // check if link is returned in header
        let rel;
        ({link, rel} = _checkNextPage(headers));

        if(rel === 'next' && link){
          streamEvent ? streamEvent.emit('data', data.products) : null;
          return resolve(_getShopProducts.bind(this)({link, products, streamEvent}));
        } else {
          streamEvent ? streamEvent.emit('data', data.products) : null;
          streamEvent ? streamEvent.emit('end') : null;
          return resolve(products);
        }
      })
    }
  })
}


// graphql api interface to get products by id
function _getShopProductsByIdentifier({identifier, defaultProductFields, ids, fields, handle, product_type, streamEvent}) {
  let products = [];

  let promiseFactory = ({id, fields, handle, product_type, streamEvent})=>{

    const fetchedFields = fields.length ? fields : defaultProductFields;

    const fragment = `
      fragment productFields on Product {
        ${fetchedFields.join(' ')}
      }
    `;

    let variables
      , queryPrefix
    ;

    switch (identifier){
      case 'id':
        variables = {id};

        queryPrefix = `
          query getProductsBYID ($id: ID!){
            product (id: $id) {
              ...productFields
              ${product_type ? 'productType' : ''}
            }
          }
        `;
        break;
      case 'handle':
        variables = {handle};

        queryPrefix = `
          query getProductsByHandle ($handle: String!){
            productByHandle (handle: $handle) {
              ... productFields
              ${product_type ? 'productType' : ''}
            }
          }
        `
        break;
    }

    const query = queryPrefix + fragment;

    return this.ShopifyGQL()
      .on('err', (err)=>{
        streamEvent ? streamEvent.emit('error', err.message) : null;
        return Promise.reject(err);
      })
      .send(JSON.stringify({query, variables}))
      .then((res)=>{
        return new Promise((resolve, reject)=>{
          const returnField = identifier === 'id' ? 'product' : 'productByHandle';

          let returnedProduct = res.body.data[returnField];

          // filter by handle and product type
          if(handle && returnedProduct.handle !== handle){
            returnedProduct = {};
          }

          if(product_type && returnedProduct.product_type !== product_type){
            returnedProduct = {};
          }

          // if any products found after filter, add to array and send back
          if(Object.keys(returnedProduct).length){
            products.push(returnedProduct);
          }

          // if using the streaming api, stream the output
          streamEvent ? streamEvent.emit('data', [returnedProduct]) : null;
          return resolve();
        })
      })
  }

  let promiseChain = Promise.resolve();

  switch(identifier){
    case 'id':
      ids.forEach((id)=>{
        promiseChain = promiseChain.then(()=> promiseFactory({id, fields, handle, product_type, streamEvent}))
      })
      break;
    case 'handle':
      promiseChain = promiseChain.then(()=> promiseFactory({fields, handle, product_type, streamEvent}))
      break;
  }


  return promiseChain
    .then(()=> Promise.resolve(products))
    .catch((err)=> Promise.reject(err))
}


// generic graphql interface to get products
function _getAllShopProducts({defaultProductFields, fields, product_type, filter, streamEvent, products=[], cursor=null}) {
  return new Promise((resolve, reject)=>{
    const fetchedFields = fields.length ? fields : defaultProductFields;
    const variantFieldPrefix = 'variant__';
    let variantFields = fetchedFields.filter(x => x.includes(variantFieldPrefix));
    variantFields = variantFields.map((x)=>{
      const regex = new RegExp(variantFieldPrefix, 'g');
      return x.replace(regex, '');
    })

    const productFields = fetchedFields.filter((x)=>{
      const isVariantField = x.includes(variantFieldPrefix);
      return !isVariantField;
    })

    const first = variantFields.length ? 5 : 250;  // if variant fields are requested, then get products in batches of 5 only

    const productFragment = `
      fragment productFields on Product {
        ${productFields.join(' ')}
      }
    `;

    const variantFragment = variantFields.length ? `
      fragment variantFields on ProductVariant {
        ${variantFields.join(' ')}
      }
    ` : '';


    const queryPrefix = `
      query getAllShopProducts ($first: Int!, $query: String, $cursor: String){
        products(first: $first, query: $query, after: $cursor) {
          pageInfo {
            hasNextPage
          }
          edges {
            cursor
            node {
              ...productFields
              ${product_type ? 'productType' : ''}

              ${variantFields.length ? 'variants (first: 100) { pageInfo { hasNextPage } edges { cursor node { ...variantFields } } }' : ''}
            }
          }
        }
      }
    `;

    let query = null;
    if(filter){
      let filterArray = [];
      _.forEach(filter, (val, key)=>{
        filterArray.push(`${key}:${val}`);
      })
      query = filterArray.join(', ');
    }

    const variables = {first, query, cursor};
    const fullQuery = queryPrefix + productFragment + variantFragment;

    this.ShopifyGQL()
      .on('err', (err)=>{
        streamEvent ? streamEvent.emit('error', err.message) : null;
        return reject(err);
      })
      .send(JSON.stringify({query:fullQuery, variables}))
      .then((res)=>{
        const edges = res.body.data.products.edges;
        cursor = edges.length ? edges[edges.length-1].cursor : null;  // set cursor to last node

        let returnedProducts = [];
        edges.forEach((edge)=>{
          returnedProducts.push(edge.node);
        })

        // if using the streaming api, stream the output
        streamEvent ? streamEvent.emit('data', returnedProducts) : null;

        // update products list
        products = products.concat(returnedProducts);

        // if there are no more pages, return the result
        const hasNextPage = res.body.data.products.pageInfo.hasNextPage;

        if(hasNextPage){
          // recurse
          return resolve(_getAllShopProducts.bind(this)({defaultProductFields, fields, product_type, filter, streamEvent, products, cursor}))
        } else {
          return resolve(products);
        }
      })
  })
}



function _getAllProductVariants({fields, filter, streamEvent=null, variants=[], cursor=null}) {
  return new Promise((resolve, reject)=>{
    const defaultVariantFields = ['id', 'title'];  // default fields that will be provided if none is specified

    const productFieldPrefix = 'product__';  // all fields of the child product node will be prefixed by this
    // get variant fields
    const requestedVariantFields = fields.filter((field)=>{
      const isNotPresent = field.indexOf(productFieldPrefix) === -1 ? true : false;
      return isNotPresent;
    })

    const variantFields = requestedVariantFields.length ? requestedVariantFields : defaultVariantFields;

    // get product fields
    let productFields = fields.filter((field)=>{
      const isPresent = field.indexOf(productFieldPrefix) > -1 ? true : false;
      return isPresent;
    })

    productFields = productFields.map((field)=>{
      const regex = new RegExp(productFieldPrefix, 'g');
      return field.replace(regex, '');
    })

    let productQuery = '';
    if(productFields.length){
      productQuery = `
        product {
          ${productFields.join(' ')}
        }
      `;
    }

    const variantQuery = `
      query getAllProductVariants ($first: Int!, $query: String, $cursor: String){
        productVariants(first: $first, query: $query, after: $cursor){
          pageInfo {
            hasNextPage
          }

          edges {
            cursor
            node {
              ...variantFragment
              ${productQuery}
            }
          }
        }
      }
    `;

    const variantFragment = `
      fragment variantFragment on ProductVariant {
        ${variantFields.join(' ')}
      }
    `;

    const fullQuery = variantQuery + variantFragment;

    let filterArray = [];
    _.forEach(filter, (val, key)=>{
      filterArray.push(`${key}:${val}`);
    })
    const query = filterArray.join(', ');


    const first = 250;
    const variables = {first, query, cursor};

    this.ShopifyGQL()
      .on('err', (err)=>{
        streamEvent ? streamEvent.emit('error', err.message) : null;
        return reject(err);
      })
      .send(JSON.stringify({query: fullQuery, variables}))
      .then((res)=>{
        const edges = res.body.data.productVariants.edges;
        cursor = edges.length ? edges[edges.length-1].cursor : null;
        const hasNextPage = res.body.data.productVariants.pageInfo.hasNextPage;

        const returnedVariants = edges.map((edge)=>{
          return edge.node;
        })

        streamEvent ? streamEvent.emit('data', returnedVariants) : null;
        variants = variants.concat(returnedVariants);

        if(hasNextPage){
          return resolve(_getAllProductVariants.bind(this)({fields, filter, streamEvent, variants, cursor}))
        } else {
          return resolve(variants);
        }

      })
  })
}



function _getShopCustomers({ids=[], fields=[], streamEvent=null, gql=false, limit=250, customers=[], link=null, cursor=null}){
  return new Promise((resolve, reject)=>{
    if(!gql){
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      let query = '';

      // specify limit on number of records returned
      query += '?limit=' + limit;

      // specify customer ids
      if(ids.length){
        query += '&ids=' + ids.join(',');
      }

      // specify fields to return
      if(fields.length){
        query += '&fields=' + fields.join(',');
      }

      // replace query with pagination link if required
      if(link){
        query = link;
      }

      this.Shopify.get('/admin/api/' + shopify_api_version + '/customers.json' + query, (err, data, headers)=>{
        if(err){return reject(new Error('error getting customers from Shopify - \n' + JSON.stringify(err.error))); }
        customers = customers.concat(data.customers);

        // recurse if needed to get more customers
        let rel;
        ({link, rel} = _checkNextPage(headers));

        if(rel === 'next' && link){
          return resolve(_getShopCustomers.bind(this)({link, customers}));
        } else {
          return resolve(customers);
        }
      })
    } else {
      // GraphQL API
      const metafields = 'metafields';  // check to see if fields requested include metafields
      const defaultCustomerFields = ['id', 'displayName'];
      let customerFields = fields.length ? fields : defaultCustomerFields;

      // check if metafields is requested
      const metafieldsRequested = customerFields.includes(metafields);

      // remove metafields from customerFields if provided
      customerFields = customerFields.filter((field)=>{
        return field !== metafields;
      })

      let metafieldQuery = ``;
      if(metafieldsRequested){
        metafieldQuery = `
          metafields (first: 50){
            edges {
              node {
                id
                key
                namespace
                value
                description
              }
            }
          }
        `;
      }

      const customerQuery = ids.length ?  `
        query getShopCustomer ($id: ID!) {
          customer (id: $id) {
            ...customerFragment
            ${metafieldQuery}
          }
        }
      ` : `
        query getShopCustomers ($first: Int!, $query: String, $cursor: String){
          customers(first: $first, query: $query, after: $cursor){
            pageInfo {
              hasNextPage
            }

            edges {
              cursor
              node {
                ...customerFragment
                ${metafieldQuery}
              }
            }
          }
        }
      `;

      const customerFragment = `
        fragment customerFragment on Customer {
          ${customerFields.join(' ')}
        }
      `;

      const fullQuery = customerQuery + customerFragment;

      const query = ids.length ? `id:${ids[0]}` : null;
      const first = metafieldsRequested ? 10 : 250;
      const variables = {first, query, cursor};

      this.ShopifyGQL()
        .on('err', (err)=>{
          streamEvent ? streamEvent.emit('error', err.message) : null;
          return reject(err);
        })
        .send(JSON.stringify({query: fullQuery, variables}))
        .then((res)=>{
          let hasNextPage
            , returnedCustomers;
          if(ids.length){
            hasNextPage = false;
            returnedCustomers = res.body.data.customer;
          } else {
            const edges = res.body.data.customers.edges;
            cursor = edges.length ? edges[edges.length-1].cursor : null;
            hasNextPage = res.body.data.customers.pageInfo.hasNextPage;

            returnedCustomers = edges.map((edge)=>{
              return edge.node;
            })
          }

          streamEvent ? streamEvent.emit('data', returnedCustomers) : null;
          customers = customers.concat(returnedCustomers);

          if(hasNextPage){
            return resolve(_getShopCustomers.bind(this)({fields, ids, streamEvent, customers, cursor, gql}))
          } else {
            return resolve(customers);
          }
        })
    }
  })
}


function _getLocationInventory({locationId, inventory_item_ids, limit=250, inventory_levels=[], link=null}) {
  return new Promise((resolve, reject)=>{
    const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
    let queryStringArray = [];

    queryStringArray.push('limit=' + limit);  // specify limit on number of records returned
    inventory_item_ids ? queryStringArray.push('inventory_item_ids=' + inventory_item_ids) : null; // specify inventory item ids to check
    queryStringArray.push('location_ids=' + locationId);  // specifiy locations to check

    const query = link ? link : '?' + queryStringArray.join('&');

    this.Shopify.get('/admin/api/' + shopify_api_version + '/inventory_levels.json' + query, (err, data, headers)=>{
      if(err){return reject(new Error('error getting inventory levels from Shopify - \n' + JSON.stringify(err.errors)))}
      inventory_levels = inventory_levels.concat(data.inventory_levels);

      // recurse if needed to get more inventory levels
      let rel;
      ({link, rel} = _checkNextPage(headers));
      if(rel === 'next' && link){
        return resolve(_getLocationInventory.bind(this)({link, inventory_levels}));
      } else {
        return resolve(inventory_levels);
      }
    })
  })
}


function _checkNextPage(headers) {
  // check if link is returned in header
  let rel = null;
  link = null;
  if(headers.link){
    const linkArray = headers.link.split(',');
    linkArray.forEach((linkArrayString)=>{
      const relString = linkArrayString.split(';')[1].trim();
      const relTest = relString.substring(relString.indexOf('"')+1, relString.lastIndexOf('"'));
      if(relTest === 'next'){
        rel = relTest;
        // link to next page has been provided so parse it out
        const urlString = linkArrayString.split(';')[0].trim();
        link = urlString.substring(urlString.indexOf('?'), urlString.lastIndexOf('>'));
      }
    })
  }

  return {link, rel};
}



function _getShopLocations({ids=[], active='all', legacy='all'}) {
  return new Promise((resolve, reject)=>{
    // get list of all shop locations
    const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
    let locations = [];
    this.Shopify.get('/admin/api/' + shopify_api_version + '/locations.json', (err, data, headers)=>{
      if(err){return reject(new Error('error getting locations from Shopify - \n' + JSON.stringify(err.error))); }
      // filter returned locations by provided parameters
      const filteredLocations = data.locations.filter((filterLocation)=>{
        let flag = true; // assume the location will be filtered in
        // filter ids
        if(ids.length){
          ids.includes(filterLocation.id) ? null : flag = false;
        }

        // filter active
        if(active !== 'all'){
          filterLocation.active === active ? null : flag = false;
        }

        // filter legacy
        if(legacy !== 'all'){
          filterLocation.legacy === legacy ? null : flag = false;
        }

        return flag;
      })

      locations = locations.concat(filteredLocations);
      return resolve(locations);
    })
  })

}


/*
 * Billing plan object
 *
 * @api public
 */

class Plan extends handy.system.BaseClass {
  constructor({id=null, name=null, shopify_plan_id=null, price=0, term='monthly', trial_length=0, test=false,
                deleted=false, active=true}, runtimeExtension=[]){

    const tableDefinition = {
      name: 'plans',
      columns: [
        {name: 'name', type: 'VARCHAR(255)', unique: true},
        {name: 'shopify_plan_id', type: 'VARCHAR(24)'},
        {name: 'price', type: 'DECIMAL(13,4)'},
        {name: 'term', type: 'VARCHAR(255)'},
        {name: 'trial_length', type: 'INT'},
        {name: 'test', type: 'BOOLEAN'},
        {name: 'active', type: 'BOOLEAN'}
      ]
    }

    super({id, name, shopify_plan_id, price, term, trial_length, test, deleted, active}, tableDefinition, runtimeExtension)
    this.name = name;
    this.shopify_plan_id = shopify_plan_id;
    this.price = price;
    this.term = term;
    this.trial_length = trial_length;
    this.test = test;
    this.deleted = deleted;
    this.active = active;
  }
}

exports.Plan = Plan;


/*
 * Create database entries for billing plans
 *
 * @params {array} definitions - array of plan definitions using format [{name, price, term, trial, test, default_plan}]
 *               plan with parameter default_plan: true is set as the initial plan for each new shop
 *
 * @api public
 */
exports.createBillingPlans = createBillingPlans;

function createBillingPlans(definitions){
  // stop processing if arguments are not properly provided
  if(!Array.isArray(definitions)){
    return Promise.reject(new Error('createBillingPlans: definitions argument needs to be an array: ', definitions))
  }

  let promiseArray = [];
  let defaultPlanId = 1;  // default plan is the first plan on the list except if otherwise specified

  const promiseFactory = (planDefinition)=>{
    let plan = new Plan(planDefinition);
    return plan.save()
      .then(()=>{
        if(planDefinition.default_plan){defaultPlanId = plan.id};  // get default plan id

        // add plans to global object
        let savedPlans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans') || {};
        savedPlans[plan.id] = plan;

        return handy.system.systemGlobal.updateConfig({shopify_app_billing_plans: savedPlans});
      })
  }

  let promiseChain = Promise.resolve();
  definitions.forEach((definition)=>{
    promiseChain = promiseChain.then(()=> promiseFactory(definition));
  })

  return promiseChain.then(()=> handy.system.systemGlobal.updateConfig({shopify_app_billing_plan_default: defaultPlanId}));
}


/*
 * Subscription object
 *
 * @api public
 */

class Subscription extends handy.system.BaseClass {
  constructor({id=null, start, end, billing_plan, shop, active=true, deleted=false}, runtimeExtension=[]){
    billing_plan = typeof billing_plan !== 'undefined' && billing_plan !== null ? billing_plan : handy.system.systemGlobal.getConfig('shopify_app_billing_plan_default');

    const tableDefinition = {
      name: 'subscriptions',
      columns: [
        {name: 'start', type: 'DATETIME'},
        {name: 'end', type: 'DATETIME'},
        {name: 'billing_plan', type: 'BIGINT'},
        {name: 'shop', type: 'BIGINT'},
        {name: 'active', type: 'BOOLEAN'}
      ],
      foreignkeys: [
        {name: "fk_billing_plan", column: "billing_plan", reference: "plans", refcolumn: "id", onupdate: "CASCADE", ondelete: "SET NULL"},
        {name: "fk_shop", column: "shop", reference: "shops", refcolumn: "id", onupdate: "CASCADE", ondelete: "SET NULL"}
      ]
    }

    super({id, start, end, billing_plan, shop, active, deleted}, tableDefinition, runtimeExtension);
    this.start = start;
    this.end = end;
    this.billing_plan = billing_plan;
    this.shop = shop;
    this.active = active;
    this.deleted = deleted;
  }

  // start new subscription
  startNewSubscription({date=new Date(), billing_plan, shop, active=true}={}){
    this.start = date;
    this.end = null;
    this.billing_plan = (billing_plan === undefined || billing_plan === null) ? this.billing_plan : billing_plan;
    this.shop = (shop === undefined || shop === null) ? this.shop : shop;
    this.active = active;
    return this.save();
  }

  // end and existing subscription
  endSubscription(){
    this.end = new Date();
    this.active = false;
    return this.save();
  }
}

exports.Subscription = Subscription;



/*
 * Order object
 *
 * @api public
 */
class Order extends handy.system.BaseClass {
  constructor({id=null, shopify_order_id=null, shopify_gql_order_id=null, order_number=null, myshopify_domain=null,
                currency=null, financial_status=null, fulfillment_status=null, line_items=[],
                deleted=false}, runtimeExtension=[]){

    const tableDefinition = {
      name: 'orders',
      columns: [
        {name: 'shopify_order_id', type: 'VARCHAR(48)'},
        {name: 'shopify_gql_order_id', type: 'VARCHAR(60)'},
        {name: 'order_number', type: 'VARCHAR(16)'},
        {name: 'myshopify_domain', type: 'VARCHAR(4096)', index: true},
        {name: 'currency', type: 'VARCHAR(64)'},
        {name: 'financial_status', type: 'VARCHAR(48)'},
        {name: 'fulfillment_status', type: 'VARCHAR(48)'},
        {name: 'line_items', type: 'LONGTEXT', datatype: 'object'},
      ]
    }

    super({id, shopify_order_id, shopify_gql_order_id, order_number, myshopify_domain, currency, financial_status,
      fulfillment_status, line_items, deleted}, tableDefinition, runtimeExtension)

    this.shopify_order_id = shopify_order_id;
    this.shopify_gql_order_id = shopify_gql_order_id;
    this.order_number = order_number;
    this.myshopify_domain = myshopify_domain;
    this.currency = currency;
    this.financial_status = financial_status;
    this.fulfillment_status = fulfillment_status;
    this.line_items = line_items;
    this.deleted = deleted;
  }
}

exports.Order = Order;


// create Shopify app specific database tables
// store
function _createDatabaseTables(){
  let promiseArray = [];
  let shop = new Shop({});
  let plan = new Plan({});
  let subscription = new Subscription({});
  let order = new Order({});
  let locationClass = new location.Location({});
  let dataStructures = [plan, shop, subscription, order, locationClass];  // due to foreign key dependencies; plan -> shop  -> subscription

  const promiseFactory = (dataStructure)=>{
    return handy.system.createDatabaseTables(dataStructure.tableDefinition)
  }

  let promiseChain = Promise.resolve();
  dataStructures.forEach((dataStructure)=>{
    promiseChain = promiseChain.then(()=> promiseFactory(dataStructure));
  })

  return promiseChain;
}

// helper function for shop.beginShopifyInstall
// creates auth_url to begin installation procedure
function _buildAuthUrl(){
  const nonce = this.nonce;
  const shopify_api_key = handy.system.systemGlobal.getConfig('shopify_api_key');
  const shopify_scope = handy.system.systemGlobal.getConfig('shopify_api_scope');
  const redirect_uri = handy.system.systemGlobal.getConfig('shopify_redirect_url');
  const myshopify_domain = this.myshopify_domain;

  const auth_url = `https://${myshopify_domain}/admin/oauth/authorize?client_id=${shopify_api_key}&scope=${shopify_scope}&redirect_uri=${redirect_uri}&state=${nonce}&grant_options[]=offline`;
  return Promise.resolve(auth_url);
}


// helper function for shop.beginShopifyInstall
// creates and saves shop.nonce if one does not exist
function _createNonce(){
  this.nonce = this.nonce || handy.utility.generateRandomString();
  return this.save();
}


/*
 * create array of functions (promises) to be executed whenever a shop installs the apps
 *
 * @param {array or promise} postInstallFunctions - array of promises (or just a single promise) to be executed
 * @api public
 */
exports.addPostAppInstallFunctions = addPostAppInstallFunctions;

function addPostAppInstallFunctions(postInstallFunctions){
  if(!postInstallFunctions){return;}

  let currentPostInstallFunctions = handy.system.systemGlobal.get('handy_shopify_postAppInstallFunctions') || [];

  if(!Array.isArray(postInstallFunctions)){
    currentPostInstallFunctions.push(postInstallFunctions);
  } else {
    postInstallFunctions.forEach((postInstallFunction)=>{
      currentPostInstallFunctions.push(postInstallFunction)
    })
  }

  return handy.system.systemGlobal.set('handy_shopify_postAppInstallFunctions', currentPostInstallFunctions);
}


/*
 * get details for current shop and save to db
 *
 */
function _updateShopDetails(){
  const query = `
    query getShopDetails {
      shop {
        id
        billingAddress {
          address1
          address2
          city
          province
          provinceCode
          zip
          countryCodeV2
          country
          name
          phone
        }
        email
        domains {
          url
        }
        myshopifyDomain
        currencyFormats {
          moneyFormat
        }
        currencyCode
        plan {
          displayName
        }
      }
    }
  `;

  return this.ShopifyGQL()
    .on('err', (err)=>{
      return Promise.reject(err);
    })
    .send(JSON.stringify({query}))
    .then((res)=>{
      const returnedShop = res.body.data.shop;
      const shopDetails = {
        shopify_gql_store_id: returnedShop.id,
        address1: returnedShop.billingAddress.address1,
        address2: returnedShop.billingAddress.address2,
        city: returnedShop.billingAddress.city,
        province: returnedShop.billingAddress.province,
        province_code: returnedShop.billingAddress.provinceCode,
        zip: returnedShop.billingAddress.zip,
        country_code: returnedShop.billingAddress.countryCodeV2,
        country: returnedShop.billingAddress.country,
        owner: returnedShop.billingAddress.name,
        email: returnedShop.email,
        phone: returnedShop.billingAddress.phone,
        domain: returnedShop.domains.reduce((acc, val)=> acc.concat(val.url).concat(';'), ''),
        myshopify_domain: returnedShop.myshopifyDomain,
        money_format: returnedShop.currencyFormats.moneyFormat,
        currency: returnedShop.currencyCode,
        shopify_plan: returnedShop.plan.displayName,
      }

      return this.updateShopShopifySettings(shopDetails)
        .then(()=>{
          this.installed = true;
          return this.save();
        })
    })
    .catch(err => Promise.reject(err))

  /*
    // create shopify api
    // get shop details from shopify
    // update and save shop details
    return new Promise((resolve, reject)=>{
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      this.createShopifyAPI()
      this.Shopify.get('/admin/api/' + shopify_api_version + '/shop.json', (err, data, headers)=>{
        if(err){ return reject(new Error('_updateShopDetails: error retrieving shop details - ' + JSON.stringify(err.error))); }
        // prep data before updating shop
        let shopDetails = handy.utility.clone(data.shop);
        shopDetails.shopify_store_id = data.shop.id;
        delete shopDetails.id;
        shopDetails.owner = data.shop.shop_owner;
        delete shopDetails.shop_owner;
        shopDetails.shopify_plan = data.shop.plan_name;
        delete shopDetails.plan_name;
        shopDetails.shopify_created_at = data.shop.created_at;
        delete shopDetails.created_at;
        shopDetails.shopify_updated_at = data.shop.updated_at;
        delete shopDetails.updated_at;

        this.updateShopShopifySettings(shopDetails)
        .then(()=>{
          this.installed = true;
          return this.save();
        })
        .then(()=> resolve())
        .catch((err)=> reject(err));
      })
    })
  */
}


/*
 * create shopify script tags
 * NOTE: this function needs to be bound to the 'this' of the shop instance ie. createScriptTags.bind(this)()
 * NOTE: shop.createShopifyAPI needs to have been run before calling this function if using REST API
 *
 * @params {array} scriptTags - array of scriptTags to be created on the shop
 * @api public
 */
exports.createScriptTags = createScriptTags;

function createScriptTags(scriptTags, gql){
  // get all current script tags
  const currentScriptTags = this.app_settings.scripttags || [];

  // check if any script tag with the same name exists
  scriptTags.forEach((scriptTag, key)=>{
    currentScriptTags.forEach((tag, index)=>{
      if(tag.script_tag.name === scriptTag.script_tag.name){
        scriptTags[key].script_tag.id = tag.script_tag.id;
        currentScriptTags[index] = scriptTag;
      }
    })
  })

  // if no existing script tag, create a new one and record in the shop settings
  // if existing script tag, update it
  const promiseFactory = (scriptTag)=>{
    return new Promise((resolve, reject)=>{
      if(gql){
        if(scriptTag.script_tag.id){
          // update existing tag
          const mutation = `
            mutation scriptTagUpdate ($id: ID!, $input: ScriptTagInput!){
              scriptTagUpdate (id: $id, input: $input) {
                scriptTag {
                  id
                  src
                  displayScope
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `;

          const variables = {
            id: scriptTag.script_tag.id,
            input: {
              displayScope: scriptTag.script_tag.display_scope,
              src: scriptTag.script_tag.src
            }
          }

          this.ShopifyGQL()
            .on('err', (err)=>{
              return reject(err);
            })
            .send(JSON.stringify({query: mutation, variables}))
            .then((res)=>{
              const returnedErrors = res.body.data.scriptTagUpdate.userErrors;
              if(returnedErrors.length){
                let returnedErrorMessageArray = [];
                returnedErrors.forEach((returnedError)=>{
                  returnedErrorMessageArray.push(returnedError.message);
                })
                const errorMessage = returnedErrorMessageArray.join('; ')
                return reject (new Error(errorMessage));
              }

              // replace script tag with same id in currentScriptTags
              currentScriptTags.forEach((tag, index)=>{
                if(tag.script_tag.id === scriptTag.script_tag.id){
                  currentScriptTags[index] = scriptTag;
                }
              })

              this.app_settings.scripttags = currentScriptTags;
              this.save()
                .then(()=> resolve())
                .catch(err => reject(err))
            })
        } else {
          // create new tag
          const mutation = `
            mutation scriptTagCreate ($input: ScriptTagInput!){
              scriptTagCreate (input: $input) {
                scriptTag {
                  id
                  src
                  displayScope
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `;

          const variables = {
            input: {
              displayScope: scriptTag.script_tag.display_scope,
              src: scriptTag.script_tag.src
            }
          }

          this.ShopifyGQL()
            .on('err', (err)=>{
              return reject(err);
            })
            .send(JSON.stringify({query: mutation, variables}))
            .then((res)=>{
              const returnedErrors = res.body.data.scriptTagCreate.userErrors;
              if(returnedErrors.length){
                let returnedErrorMessageArray = [];
                returnedErrors.forEach((returnedError)=>{
                  returnedErrorMessageArray.push(returnedError.message);
                })
                const errorMessage = returnedErrorMessageArray.join('; ')
                return reject (new Error(errorMessage));
              }

              const returnedScriptTag = res.body.data.scriptTagCreate.scriptTag;
              scriptTag.script_tag.id = returnedScriptTag.id;
              currentScriptTags.push(scriptTag);
              this.app_settings.scripttags = currentScriptTags;
              this.save()
                .then(()=> resolve())
                .catch(err => reject(err))
            })
        }
      } else {
        this.createShopifyAPI();
        const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
        if(scriptTag.script_tag.id){
          // update existing script tag
          this.Shopify.put('/admin/api/' + shopify_api_version + '/script_tags/' + scriptTag.script_tag.id + '.json', scriptTag, (err, data, headers)=>{
            if(err){return reject(new Error('createScriptTags: error creating scripttags ' + scriptTag.script_tag.name + ' - ' + JSON.stringify(err))); }
            // save updated script tag to shop
            this.app_settings.scripttags = currentScriptTags;

            return this.save()
              .then(resolve)
              .catch(reject);
          })
        } else {
          // create new script tag
          this.Shopify.post('/admin/api/' + shopify_api_version + '/script_tags.json', scriptTag, (err, data, headers)=>{
            if(err){return reject(new Error(`createScriptTags: error creating scripttags ${scriptTag.script_tag.name} - ${err.message}`))}
            // save script tag to shop
            currentScriptTags.push(scriptTag);
            this.app_settings.scripttags = currentScriptTags;
            return this.save()
              .then(resolve)
              .catch(reject);
          })
        }
      }
    })
  }

  let promiseChain = Promise.resolve();
  scriptTags.forEach((scriptTag)=>{
    promiseChain = promiseChain.then(()=> promiseFactory(scriptTag));
  })

  return promiseChain
//  .catch(err => Promise.reject(err))
}


function _createWebhooks(){
  const gql = true;
  const webhooks = _getDefaultWebhooks(gql);

  return createWebhooks.bind(this)(webhooks, gql)
    .catch(err=> Promise.reject(err))
}


function _getDefaultWebhooks(gql) {
  const webhook_address = handy.system.systemGlobal.getConfig('siteURL') + handy.system.systemGlobal.get('webhooks_base_path');

  const webhooks = [
    {
      webhook:{
        topic: gql ? 'APP_UNINSTALLED' : 'app/uninstalled',
        address: webhook_address + '/app_uninstalled',
        format: gql ? 'JSON' : 'json'
      }
    },
    {
      webhook:{
        topic: gql ? 'SHOP_UPDATE' : 'shop/update',
        address: webhook_address + '/shop_update',
        format: gql ? 'JSON' : 'json'
      }
    },
  ];

  return webhooks;
}


/*
 * create shopify webhooks
 * NOTE: this function needs to be bound to the 'this' of the shop instance ie. createWebhooks.bind(this)()
 * NOTE: shop.createShopifyAPI needs to have been run before calling this function if using REST API
 *
 * @params {array} webhooks - array of webhooks to be created on the store
 * @api public
 */
exports.createWebhooks = createWebhooks;

function createWebhooks(webhooks, gql=false){
  const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
  let promiseArray = [];

  const promiseFactory = (webhook, gql)=>{
    return new Promise((resolve, reject)=>{
      if(gql){
        // if webhook already exists, skip recreating it
        this.app_settings.webhooks = this.app_settings.webhooks || [];
        let webhookExists = false;
        this.app_settings.webhooks.forEach((currentWebhook, key)=>{
          if(currentWebhook.webhook.topic === webhook.webhook.topic){
            webhookExists = true;
          }
        })

        if(webhookExists){return resolve();}  // stop processing if the webhook is already set

        const mutation = `
          mutation webhookSubscriptionCreate ($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate (topic: $topic, webhookSubscription: $webhookSubscription) {
              userErrors {
                field
                message
              }

              webhookSubscription {
                id
              }
            }
          }
        `;

        const variables = {
          topic: webhook.webhook.topic,
          webhookSubscription: {
            callbackUrl: webhook.webhook.address,
            format: webhook.webhook.format,
            includeFields: [],
            metafieldNamespaces: []
          }
        }

        this.ShopifyGQL()
          .on('err', (err)=>{
            return reject(err);
          })
          .send(JSON.stringify({query: mutation, variables}))
          .then((res)=>{
            const returnedErrors = res.body.data.webhookSubscriptionCreate.userErrors;
            if(returnedErrors.length){
              let returnedErrorMessageArray = [];
              returnedErrors.forEach((returnedError)=>{
                returnedErrorMessageArray.push(returnedError.message);
              })
              const errorMessage = returnedErrorMessageArray.join('; ')
              return reject (new Error(errorMessage));
            }

            const returnedWebhook = res.body.data.webhookSubscriptionCreate.webhookSubscription;

            // save webhook in shop settings
            webhook.webhook.id = returnedWebhook.id;
            this.app_settings.webhooks.push(webhook);

            this.save()
              .then(()=> resolve())
              .catch(err => reject(err))
          })
          .catch(err=> Promise.reject(err))

      } else {
        this.Shopify.post('/admin/api/' + shopify_api_version + '/webhooks.json', webhook, (err, data, headers)=>{
          if(err){
            //Hack Fix for an issue on creating store: {"code":422,"error":{"address":["for this topic has already been taken"]}}
            if (!(webhook.webhook.topic === 'app/uninstalled' || webhook.webhook.topic === 'APP_UNINSTALLED'))
              return reject(new Error('createWebhooks: error creating webhook ' + webhook.webhook.topic + ' - ' + JSON.stringify(err)));
          }

          // save webhooks in shop settings, if does not already exist
          this.app_settings.webhooks = this.app_settings.webhooks || [];
          let webhookExists = false;
          this.app_settings.webhooks.forEach((currentWebhook, key)=>{
            if(currentWebhook.webhook.topic === webhook.webhook.topic){
              webhookExists = true;
              this.app_settings.webhooks[key] = webhook;
            }
          })

          // if no existing webhook, then add the new one
          webhookExists ? null : this.app_settings.webhooks.push(webhook);
          return this.save()
            .then(()=> resolve())
            .catch((err)=> reject(err));
        })
      }
    })
  }

  let promiseChain = Promise.resolve();
  webhooks.forEach((webhook)=>{
    promiseChain = promiseChain.then(()=> promiseFactory(webhook, gql));
  })

  return promiseChain;
}


/*
 * set onboarding admin message
 * NOTE: this function needs to be bound to the 'this' of the shop instance ie. createWebhooks.bind(this)()
 *
 * @params {array} messages - array of messages to be set
 *    message format {style: style_type, text: string or array of strings}
 *    style_type (header - header text; text - regular text; list - expand array of text property)
 *
 * @api public
 */

exports.setOnboardingAdminMessage = setOnboardingAdminMessage;

function setOnboardingAdminMessage(messages=[]) {
  messages = Array.isArray(messages) ? messages : [messages];
  const promiseFactory = (message)=>{
    return this.createAdminNotification(message)
  }

  let promiseChain = Promise.resolve();

  messages.forEach((message)=>{
    promiseChain = promiseChain.then(()=> promiseFactory(message))
  })
  return promiseChain;
}


/*
 * authenticate JWT tokens
 *
 * @params {obj} req - request object
 * @params {obj} res - response object
 * @params {function} next - express next function
 * @api public
 */
exports.authenticateJWT = authenticateJWT;

function authenticateJWT(req, res, next) {
  const session_token = req.headers['session-token'] || '..';
  const header = session_token.split('.')[0];
  let payload = session_token.split('.')[1];
  const signature = session_token.split('.')[2];
  const shopify_shared_secret = handy.system.systemGlobal.getConfig('shopify_shared_secret');
  const shopify_api_key = handy.system.systemGlobal.getConfig('shopify_api_key');
  let hmac = crypto.createHmac('sha256', shopify_shared_secret);
  hmac.update(`${header}.${payload}`);
  const compareSignature = hmac.digest('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');  // shopify encodes with base64url

  try {
    payload = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    const expVarify = payload.exp - now > 0 ? true : false;
    const nbfVerify = now - payload.nbf >= 0 ? true : false;
    const audVerify = payload.aud === shopify_api_key;
    const signatureVerify = compareSignature === signature;
    if(expVarify && nbfVerify && audVerify && signatureVerify){
      req.myshopify_domain = payload.dest.replace('https://', '');
      next();
    } else {
      next(new Error('jwt not verified'))
    }
  }
  catch(err){
    next(new Error('error getting jwt'));
  }
}



/*
 * authenticate incoming webhook requests
 *
 * @params {obj} req - request object
 * @params {obj} res - response object
 * @params {obj} next - express next function
 * @api public
 */
exports.authenticateWebhook = authenticateWebhook;

function authenticateWebhook(req, res, next){
  const myshopify_domain = req.headers['x-shopify-shop-domain'];
  const verify_hmac = req.headers['x-shopify-hmac-sha256'];
  const data = req.rawBody;
  let shop = new Shop({myshopify_domain})

  // DEBUG: skip authenticate webhook requests
  // console.log('DEBUG: skip authenticate webhook requests')
  // next();
  // return;

  shop.load('myshopify_domain')
    .then(()=>{
//    shop.createShopifyAPI();
      const shopify_shared_secret = handy.system.systemGlobal.getConfig('shopify_shared_secret');
      let hmac = crypto.createHmac('sha256', shopify_shared_secret);
      hmac.update(data);
      const calc_hmac = hmac.digest('base64');
      if(calc_hmac === verify_hmac){
        return next();
      } else {
        res.status(200).send({done: false});  // send a 200 response to placate the webhook sender but stop processing
        return next(new Error('webhook request not verified'));
      }
    })
    .catch((err)=> {
      res.status(200).send({done: false});  // send a 200 response to placate the webhook sender but stop processing
      next(err);
    })
}


/*
 * authenticate incoming shopify requests
 * shopify makes two types of requests - regular and app proxy
 * regular requests are anything that results from ..myshopify.com/app_path/request_path
 * app proxy requests result from ..myshopify.com/app_proxy_path/request_path
 * regular requests make use of a query parameter 'hmac' while app proxy requests use 'signature'
 * both types of requests are also validated slightly differently
 *
 * @params {obj} req - request object
 * @params {obj} res - response object
 * @params {obj} next - express next function
 * @api public
 */
exports.authenticateShopifyRequest = authenticateShopifyRequest;

function authenticateShopifyRequest(req, res, next){
  // do not authenticate POST requests
  if(req.method === 'POST' && req._handyReqType !== 'app_proxy'){
    return next();
  }

  const requestType = req.query.hmac ? 'regular' : 'app_proxy';
  return requestType === 'regular' ? _authenticateRegularShopifyRequests(req, res, next) : _authenticateAppProxyShopifyRequest(req, res, next);
}


/*
 * helper function for authenticateShopifyRequest
 * authenticate incoming regular requests
 */
function _authenticateRegularShopifyRequests(req, res, next){
  let query = req.query;

  // create a clone of req.query in order not to modify it as there may need to
  // be transforms applied to make the values ready for verification
  let queryClone = {};
  _.forEach(req.query, (val, key)=>{

    // if the query is an array (e.g. id=x&id=y which gets transformed into req.query.id = ['x', 'y'])
    // need to transform into format id = ["x", "y"]  (note the double quotes and spaces)
    if(Array.isArray(val)){
      let valToString = '[';
      val.forEach((valItem)=>{
        valToString += '"' + valItem + '", ';
      })
      valToString = handy.utility.removeTrailingCharacter(valToString, ', ') + ']';
      queryClone[key] = valToString;
    } else {
      queryClone[key] = val;
    }
  })


  if(_internalUrlHashValidation(query)){
    return next();
  }

  const myshopify_domain = req.query.shop;
  let shop = new Shop({myshopify_domain});
  shop.load('myshopify_domain')
    .then(()=>{
//    shop.createShopifyAPI();
      const requestVerified = shop.isValidSignature(queryClone, true);
//    const requestVerified = shop.Shopify.is_valid_signature(queryClone, true);
      return requestVerified ? next() : Promise.reject(new Error('shopify request could not be verified'));
    })
    .catch((err)=> {
      next(new Error('shopify request authenticatation failed - \n', err.message))
      handy.system.log({req, level: 'error', category: 'system', msg: 'error authenicating shopify regular request', shop: shop.myshopify_domain, err});
    })
}


/*
 * authenticate incoming app proxy redirect requests
 * **** NOTE: It appears this function can be refactored to use shop.isValidSignature *******
 */

function _authenticateAppProxyShopifyRequest(req, res, next){
  let query = req.query;
  if(_internalUrlHashValidation(query)){
    return next();
  }

  const signature = query.signature;
  delete query.signature;

  let parameters = [];
  for (let key in query) {
    if (key !== "hmac" && key !== "signature") {
      parameters.push(key + '=' + query[key]);
    }
  }

  let message = parameters.sort().join('');
  const shopify_shared_secret = handy.system.systemGlobal.getConfig('shopify_shared_secret');

  const calculatedSignature = crypto.createHmac('sha256', shopify_shared_secret)
    .update(message)
    .digest('hex');

  if(calculatedSignature === signature){
    next();
  } else {
    const err = new Error('shopify app proxy request could not be verified');
    next(err);
    handy.system.log({req, level: 'error', category: 'system', msg: 'shopify app proxy request failed verification', err});
  }

}


/*
 * generate internal url request validation hash
 *
 * @api public
 */
exports.generateInternalUrlRequestHash = generateInternalUrlRequestHash;

function generateInternalUrlRequestHash(){
  return new Promise((resolve, reject)=>{
    crypto.randomBytes(64, (err, hash)=>{
      if(err){return reject(new Error('error creating internal url request hash - ' + err.message)); }
      hash = hash.toString('base64');
      // remove all url unsafe characters
      // NOTE: this is better than encodeURIComponent because express applies decodeURIComponent
      // automatically which screws up the comparison
      hash = hash.replace(/[^a-zA-Z0-9-_]/g, '');
      let internal_url_request_hash_validation = handy.system.systemGlobal.get('internal_url_request_hash_validation') || [];
      internal_url_request_hash_validation.push(hash);
      handy.system.systemGlobal.set('internal_url_request_hash_validation', internal_url_request_hash_validation);
      return resolve(hash);
    })
  })
}


/*
 * check if handy_shopify_url_validation_hash query parameter is provided.
 * if so, validate the parameter.  if valid, then bypass the rest of the validation
 * this is to enable internal redirect access to paths that would otherwise require
 * Shopify validation
 */

function _internalUrlHashValidation(query){
  let hashValidation = false;
  if(query.handy_shopify_url_validation_hash){
    let internal_url_request_hash_validation = handy.system.systemGlobal.get('internal_url_request_hash_validation') || [];
    hashValidation = internal_url_request_hash_validation.includes(query.handy_shopify_url_validation_hash);
    // remove validated hash from future use
    internal_url_request_hash_validation = _.without(query.handy_shopify_url_validation_hash);
    handy.system.systemGlobal.set('internal_url_request_hash_validation', internal_url_request_hash_validation);
  }

  return hashValidation;
}

/*
 * create shop sessions
 * Instead of creating user sessions, shop sessions are more appropriate
 * shop sessions are used to validate all requests from the client that
 * do not have Shopify credentials e.g. any requests generated from within
 * the embedded app iframe
 *
 * @params {obj} req - express request object
 * @params {obj} res - express response object
 * @params {function} next - express next function
 * @api public
 */
exports.createShopSession = createShopSession;

function createShopSession(req, res, next){
  console.log('** createShopSession DEPRECATED: please do not use anymore **')
  // stop processing if a session already exists
  if(req.session.shop && req.session.shop.myshopify_domain === req.query.shop){
    return next();
  }

  // stop processing if request is POST and session is already set
  // rationale: POST requests are always applied to the shop specified in req.session.shop
  // assumption is that the session cookie is kept safe and cannot be forged
  if(req.session.shop && req.method === 'POST'){
    return next();
  }

  const myshopify_domain = req.query.shop;
  let shop = new Shop({myshopify_domain});
  shop.load('myshopify_domain')
    .then(()=>{

      return new Promise((resolve, reject)=>{
        req.session.regenerate((err)=>{
          if(err){ return reject(err); }

          req.session.shop = shop;
          return resolve();
        })
      })
    })

    .then(()=>{
      return next()
    })

    .catch((err)=>{
      return next(new Error('error creating new shop session - \n', err.message));
    })
}


/*
 * add webhook processors
 * designate functions to execute upon receipt of webhooks
 * these functions are called upon processing the 'shopifyWebhook' queue
 * functions are executed with arguments (shop, app, req, res, data)
 *
 * @params (obj) processor - object with format {event: processor}
 *
 * @api public
 */
exports.addWebhookProcessors = addWebhookProcessors;

function addWebhookProcessors(processor){
  let webhookProcessors = handy.system.systemGlobal.get('webhookProcessors') || {};
  _.forEach(processor, (val, key)=>{
    webhookProcessors[key] = val;
  })

  handy.system.systemGlobal.set('webhookProcessors', webhookProcessors);
  return;
}


/*
 * process webhook items in task queue
 * shopify webhook items are identified by task type 'shopifyWebhook'
 * since this function is usually invoked under cron, it returns result of true if successful or false, otherwise
 *
 * @params {obj} app - express app object
 * @params {obj} req - express request object
 * @params {obj} res - express response object
 * @params {function} callback - callback to be invoked with arguments (err, result)
 *
 * @api public
 */
exports.processWebhookQueue = processWebhookQueue;

function processWebhookQueue(app, req, res, callback){
  const promiseFactory = (item, app, req, res)=>{
    return _processQueueItem(item, app, req, res)
      .then(()=> handy.system.removeQueueItem(item))
      .catch((err)=> {
        // todo: log error
        console.log('Error on processWebhookQueue', err);
        return handy.system.changeQueueItemLockStatus(item, false); // unlock queue item
      });
  }

  const respectLocks = true;  // ensure only unlocked queue items are returned to avoid double processing
  handy.system.getQueueItems({type: 'shopifyWebhook'}, respectLocks)
    .then((items)=>{
      let promiseChain = Promise.resolve();
      items.forEach((item)=>{
        promiseChain = promiseChain.then(()=> promiseFactory(item, app, req, res));
      })

      return promiseChain;
    })
    .then(()=> callback(null, true))
    .catch((err)=> callback(err, false));
}


// helper function for processWebhookQueue
function _processQueueItem(item, app, req, res){
  return new Promise((resolve, reject)=>{
    let event, shop, data, webhookProcessors;
    try{
      const payload = JSON.parse(item.payload);
      event = payload.event;
      shop = JSON.parse(payload.shop);
      data = payload.data !== undefined && payload.data !== '' ? JSON.parse(payload.data) : {};
      webhookProcessors = handy.system.systemGlobal.get('webhookProcessors');
    }
    catch(err){
    }

    webhookProcessors[event](shop, app, req, res, data)
      .then(()=> resolve())
      .catch((err)=> reject(err));
  })
}


// webhook processor for event app_uninstalled
exports._uninstallShop = _uninstallShop;
function _uninstallShop(shop){
  const myshopify_domain = shop.myshopify_domain;
  let uninstallShop = new Shop({myshopify_domain});

  return uninstallShop.load('myshopify_domain')
    .then(()=> uninstallShop.uninstallApp())
    .catch((err)=> Promise.reject(err))
}

// webhook processor for event shop_update
function _updateShop(shop){
  const myshopify_domain = shop.myshopify_domain;
  let updateShop = new Shop({myshopify_domain});

  return updateShop.load('myshopify_domain')
    .then(()=> updateShop.updateShopShopifySettings(shop))
    .catch((err)=> Promise.reject(err));
}

// webhook processor for redacting shop data
function _redactShopData(shop, app, req, res, data) {
  let redactShop = new Shop({myshopify_domain: shop.myshopify_domain})
  return redactShop.load('myshopify_domain')
    .then(()=>{
      if(!redactShop.installed){
        redactShop.owner += '_redacted';
        redactShop.email += '_redacted';
        redactShop.phone += '_redacted';
        return redactShop.save();
      }

      return Promise.resolve();
    })
}



/*
 * middleware to begin shop installation process
 *
 * @params {obj} req - express request object
 * @params {obj} res - express response object
 * @params {function} next - express next function
 * @api public
 */

exports.installShop = installShop;

function installShop(req, res, next){
  // bypass on POST requests
  if(req.method === 'POST'){
    return next();
  }

  let pageInfo = handy.system.prepRender(req, res);

  let shop = req.query.shop;

  // if no shop is provided then redirect to request shop credential
  if(!shop){
    return res.render('shopify_install.pug', {pageInfo});
  }

  // ensure shop ends with '.myshopify.com', if not add it in
  shop += shop.endsWith('.myshopify.com') ? '' : '.myshopify.com';
  return _checkIfShopIsInstalled(shop)
    .then((installedFlag)=> {
      // if shop is already installed, then return next()
      if(installedFlag){
        return next();
      }

      let installShop = new Shop({myshopify_domain: shop});

      return installShop.beginShopifyInstall()
        .then((shopifyAuthUrl)=>{

//      // set billing plan to default
//      installShop.billing_plan = handy.system.systemGlobal.getConfig('shopify_app_billing_plan_default');

          // set notifications to default
          installShop.admin_notifications = {dismissable:[], snoozeable:[]};

          // set emulations to default
          installShop.emulations = {};

          // create initial subscription
          const plan = handy.system.systemGlobal.getConfig('shopify_app_billing_plan_default');
          return installShop.save()
            .then(()=> installShop.updateSubscription(plan))
            .then(()=> Promise.resolve(shopifyAuthUrl))
          /*
                return installShop.save()
                .then(()=> Promise.resolve(shopifyAuthUrl));
          */
        })
        .then((shopifyAuthUrl)=> res.redirect(shopifyAuthUrl))
        .catch((err)=> {
          res.status(500).send('error initiating shopify app install - \n' + err.message)
        })

    })

}


// helper function for installShop
// checks if shop is already installed
// returns true or false
function _checkIfShopIsInstalled(shop){
  return new Promise((resolve, reject)=>{
    // get list of installed shops from memory
    let installedShops = handy.system.systemGlobal.get('installed_shops') || [];
    let shopInstalledFlag = false;
    installedShops.forEach((installedShop)=>{
      if(installedShop.myshopify_domain === shop && installedShop.installed){
        shopInstalledFlag = true;
      }
    })

    if(shopInstalledFlag){return resolve(true); }

    // check database to be sure
    let installShop = new Shop({myshopify_domain: shop});
    installShop.load('myshopify_domain')
      .then(()=> {
        if(installShop.installed){
          // update memory for faster future requests
          installedShops.push(installShop);
          handy.system.systemGlobal.set('installed_shops', installedShops);
          return resolve(true);
        } else {
          return resolve(false);
        }

      })
      .catch((err) => resolve(false))
  })
}


// middleware to check if shop has the most current access scopes
exports.validateAccessScopes = validateAccessScopes;

async function validateAccessScopes(req, res, next) {
  const myshopify_domain = req.query.shop;
  let shop = new Shop({myshopify_domain});
  try{
    await shop.load('myshopify_domain');
    // check shop has right access scopes.  if not, update them
    const accessScopes = await shop.getAccessScopes();
    const requiredScopes = handy.system.systemGlobal.getConfig('shopify_api_scope').split(',').map(x => x.trim());
    let missingScopes = [];
    requiredScopes.forEach((scope)=>{
      !accessScopes.includes(scope) ? missingScopes.push(scope) : null;
    })

    // if there are missing scopes, ask user to authorize adding new scopes
    if(missingScopes.length){
      const shopify_api_key = handy.system.systemGlobal.getConfig('shopify_api_key');
      //    const redirectDestination = `https://${shop.myshopify_domain}/admin/apps/${shopify_api_key}`
      const redirect_url = await _buildAuthUrl.bind(shop)();
      let pageInfo = handy.system.prepRender(req, res);
      prepAdminRender(req, res, pageInfo);
      pageInfo.redirect_url = redirect_url;

      res.render('update_access_scopes', {pageInfo});
    } else {
      return next();
    }
  }
  catch(err){
    // the most likely reason why the try block would fail is if the shop is not installed, so just proceed
    next();
  }
}



exports.prepAdminRender = prepAdminRender;

// add shopify environment variables in preparation for render
function prepAdminRender(req, res, pageInfo={}) {
  handy.system.setCDNHeaders(res);
  pageInfo.shopify = pageInfo.shopify || {};
  pageInfo.shopify.shopify_api_key = handy.system.systemGlobal.getConfig('shopify_api_key');
  pageInfo.shopify.shopify_shared_secret = handy.system.systemGlobal.getConfig('shopify_shared_secret');
  pageInfo.shopify.shopify_api_scope = handy.system.systemGlobal.getConfig('shopify_api_scope');
  pageInfo.shopify.shopify_redirect_url = handy.system.systemGlobal.getConfig('shopify_redirect_url');
  pageInfo.shopify.myshopify_domain = req.query.shop;
  pageInfo.shopify.myshopify_host = req.query.host;
  return;
}
