'use strict';

const path = require('path')
  , express = require('express')
  , cors = require('cors')
  , _ = require('underscore')
  , moment = require('moment')
  , handy = require('@takinola/handy')
  , shopify = require(path.join(__dirname, '..', 'lib', 'handy-shopify'))
  ;

module.exports = function(app){
  const shopifyRouter = express.Router()
  , handyRouter = express.Router()
  , shopifyAdminRouter = express.Router()
  , shopifyEmbedRouter = express.Router()
  ;




  /************************************************************************************/
  /******************************** handy Routes **************************************/
  /************************************************************************************/

  handyRouter.get('/configuration/shopify', handy.user.isAuthenticated, (req, res)=>{
    let pageInfo = handy.system.prepRender(req, res);
    // get configuration
    pageInfo.shopify_config = {
      shopify_api_key: handy.system.systemGlobal.getConfig('shopify_api_key'),
      shopify_shared_secret: handy.system.systemGlobal.getConfig('shopify_shared_secret'),
      shopify_api_scope: handy.system.systemGlobal.getConfig('shopify_api_scope'),
      shopify_api_version: handy.system.systemGlobal.getConfig('shopify_api_version'),
      shopify_redirect_url: handy.system.systemGlobal.getConfig('shopify_redirect_url')
    };

    pageInfo.billingPlans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans') || {};
    shopify.loadInstalledShops()
    .then(()=>{
      let installedShops = handy.system.systemGlobal.get('installed_shops') || [];
      const promiseFactory = (shop)=>{
        let promiseShop = new shopify.Shop({myshopify_domain: shop.myshopify_domain})
        return promiseShop.load('myshopify_domain')
        .then(()=> promiseShop.getBillingPlan())
        .then((billing_plan)=>{
          shop.billing_plan = billing_plan;
          return Promise.resolve();
        })
      }

      let promiseChain = Promise.resolve();

      installedShops.forEach((shop)=>{
        promiseChain = promiseChain.then(()=> promiseFactory(shop))
      })

      return promiseChain
      .then(()=> Promise.resolve(installedShops))

    })
    .then((installedShops)=>{
      pageInfo.installedShops = installedShops;
      handy.system.systemMessage.get(req, res);
      res.render('shopify_config', {pageInfo});
      handy.system.log({req, level: 'info', category: 'system', msg: 'shopify configuration displayed'});      
    })
    .catch((err)=>{
      res.status(500).send('error loading shopify config display - \n' + err.message);
      handy.system.log({req, level: 'error', category: 'system', msg: 'shopify configuration display error', err});      
    })
  })

  handyRouter.get('/shopify_analytics', handy.user.isAuthenticated, (req, res)=>{
    let pageInfo = handy.system.prepRender(req, res);
    let {start, end} = req.query;
    let data = {};
    if(!start || !end){
      res.render('shopify_analytics', {pageInfo});
    } else {

      handy.system.createTemporaryPool()
      .then((pool)=>{
        // convert start and end to moments
        start = moment(start, 'YYYY/MM/DD');
        end = moment(end, 'YYYY/MM/DD');

        const chartTypes = ['customer_count', 'customer_adds', 'customer_losses', 'plan_changes'];
        let promiseArray = [];
        chartTypes.forEach((type)=>{
          for(let i=start.clone(); i.isSameOrBefore(end); i.add(1, 'days')){
            promiseArray.push(getReport(type, i.clone(), pool))
          }
        })

        return Promise.all(promiseArray)
        .then((reports)=>{
          return new Promise((resolve, reject)=>{
            // reports is in format [{type1: {date1: {line1: val1}}}, {}]
            reports.forEach((report)=>{
              Object.keys(report).forEach((reportType)=>{
                data[reportType] = data[reportType] || {};
                Object.keys(report[reportType]).forEach((reportDate)=>{
                  data[reportType][reportDate] = report[reportType][reportDate];
                })
              })
            })

            res.status(200).send(JSON.stringify({data}));
            handy.system.log({req, level: 'info', category: 'system', msg: 'shopify analytics displayed'})
            return resolve(pool);
          })
        })
        .catch((err)=>{
          return new Promise((resolve, reject)=>{
            res.status(500).send(JSON.stringify({error: 'error getting report - ' + err.message}));
            return resolve(pool);
          })
        })
      })
      .then((pool)=> handy.system.destroyTemporaryPool(pool))
      .catch((err)=> handy.system.destroyTemporaryPool(pool));
    }
  })
  
  app.use('/handy', handyRouter);

  /************************************************************************************/
  /****************************** Shopify Routes **************************************/
  /************************************************************************************/

  // enable ACCESS-CONTROL-ALLOW-ORIGIN header (required for shopify app-bridge)
  shopifyRouter.options('*', cors())

  // app installation completion
  shopifyRouter.get('/install_redirect_uri', cors(), (req, res)=>{
    handy.system.setCDNHeaders(res);
    const params = req.query;

    let installShop = new shopify.Shop({myshopify_domain: params.shop});
    installShop.completeShopifyInstall(params)
//    .then(shopify.generateInternalUrlRequestHash)
//    .then((handy_shopify_url_validation_hash)=> {
    .then(()=>{
      const shop = installShop.myshopify_domain;
      const shopify_api_key = handy.system.systemGlobal.getConfig('shopify_api_key');
      const redirectDestination = `https://${shop}/admin/apps/${shopify_api_key}`

/*
      // redirect user to settings page within Shopify admin panel
      let query = {handy_shopify_url_validation_hash, shop}
      
      let queryStringArray = [];
      _.forEach(query, (val, key)=>{
        queryStringArray.push(key + '=' + val);
      })

      const queryString = queryStringArray.join('&');
      const redirectDestination = '/handy/shopify/admin?' + queryString;
*/
      res.redirect(redirectDestination);
      handy.system.log({req, level: 'info', category: 'system', msg: 'shopify install completed', shop: installShop.myshopify_domain});
    })
    .catch((err)=>{
      res.status(500).send('error completing shopify app install - ' + err.message);
      handy.system.log({req, level: 'error', category: 'system', msg: 'error completing shopify install', shop: installShop.myshopify_domain, err});
    })
  })


  // display and manipulate record of individual shops
  shopifyRouter.get('/shop/:shop', handy.user.isAuthenticated, (req, res)=>{
    handy.system.setCDNHeaders(res);
    if(!req.params.shop){
      return res.send('please specify a shop to display')
    }

    let shop = new shopify.Shop({myshopify_domain: req.params.shop});
    shop.load('myshopify_domain')
    .then(()=> shop.getBillingPlan())
    .then((billing_plan)=>{
      shop.billing_plan = billing_plan.name;
      let pageInfo = handy.system.prepRender(req, res);
      pageInfo.shop = shop;
      pageInfo.billingPlans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans') || {};
      pageInfo.shopifyPlans = handy.system.systemGlobal.get('shopify_plan_list') || [];
      pageInfo.emulations = shop.emulations || {};
      return res.render('shop', {pageInfo})
    })
    .catch((err)=> res.status(500).send(JSON.stringify(err, null, 2)));
  })

  // list all currently installed shops and display their orders
  // note: display orders may not work if read order scope is not requested
  shopifyRouter.get('/listshops/:shop?', handy.user.isAuthenticated, (req, res)=>{
    handy.system.setCDNHeaders(res);
    // if no shop is provided, get list of installed shops
    if(!req.params.shop){
      // return display of shops as links to '/test/<shop>'
      return _displayShopList(req, res)
    }
   
    // if shop is provided
    let shop = new shopify.Shop({myshopify_domain: req.params.shop})
    shop.load('myshopify_domain')
    .then(()=> {
      let pageInfo = handy.system.prepRender(req, res);
      pageInfo.displayMode = 'single';
      pageInfo.shopDetails = shop;

      return res.render('shoplist', {pageInfo})
    })
    .catch((err)=> res.status(500).send(JSON.stringify(err, null, 2)))
  })

  function _displayShopList(req, res){
    const pool = handy.system.systemGlobal.get('pool');
    pool.getConnection((err, connection)=>{
      const query = 'SELECT owner, email, domain, myshopify_domain FROM shops WHERE installed=true';
      connection.query(query, (err, results)=>{
        connection.release();
        let pageInfo = handy.system.prepRender(req, res);
        pageInfo.displayMode = 'all';
        pageInfo.shopList = results;
        return res.render('shoplist', {pageInfo});
      })
    })
  }

  app.use('/handy/shopify', shopifyRouter);


  /************************************************************************************/
  /************************** Shopify Admin Routes ************************************/
  /************************************************************************************/

  shopifyAdminRouter.options('*', cors());

  shopifyAdminRouter.get('/billing', cors(), (req, res)=>{
    const query = req.query;
    let pageInfo = handy.system.prepRender(req, res);
    shopify.prepAdminRender(req, res, pageInfo);
    const myshopify_domain = req.query.shop;
    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
    .then(()=> shop.getBillingPlan())
//      .then((billing_plan)=> Promise.resolve(billing_plan))
    .then((billing_plan)=>{
      pageInfo.app_settings = shop.app_settings;
      pageInfo.app_settings.myshopify_domain = shop.myshopify_domain;
      pageInfo.query = query;
      pageInfo.billing_plan = billing_plan.id;

      // get name of current shop plan
      let plans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans') || {};
      let displayedPlans = [];
      _.forEach(plans, (plan)=>{
        if(plan.id === billing_plan.id){pageInfo.plan_name = plan.name; }
        if(plan.active){displayedPlans.push(plan.name); }
      })

      pageInfo.shopify_plan = shop.shopify_plan;
      pageInfo.displayedPlans = displayedPlans;
      pageInfo.emulations = shop.emulations || {};
      res.render('shopify_billing', {pageInfo});
      handy.system.log({req, level: 'info', category: 'system', msg: 'billing choice displayed', shop: shop.myshopify_domain});
    })
  })


  shopifyAdminRouter.use(shopify.installShop, // check if shop is installed, if not prompt installation
    shopify.authenticateShopifyRequest,
//    shopify.createShopSession // shop session is used to identify the shop for future requests
  );  
  
  app.use('/handy/shopify/admin', shopifyAdminRouter);


  /************************************************************************************/
  /************************** Shopify Embedded Routes *********************************/
  /************************************************************************************/

  /* embed routes are required for calls from within the Shopify interface that do not include
  /* an hmac or signature query parameter.  validation in these cases come from the shop session
  /* cookie
  */

  shopifyEmbedRouter.options('*', cors());

  shopifyEmbedRouter.get('/billing_charge_activate', cors(), (req, res)=>{
    handy.system.setCDNHeaders(res);
    const {charge_id, billing_plan, test_flag=false} = req.query;
//    const {myshopify_domain} = req.session.shop;
    const myshopify_domain = req.query.shop;
    let shop = new shopify.Shop({myshopify_domain});

    shop.load('myshopify_domain')
    .then(()=> shop.activateCharge({charge_id, billing_plan, test_flag}))
    .then(({redirect_url, status})=>{
      if(status !== 'active'){
        return res.redirect(redirect_url)
      }

      res.redirect(redirect_url)
      handy.system.log({req, level: 'info', category: 'system', msg: 'billing plan updated', shop: shop.myshopify_domain});
    })
    .catch((err)=> {
//      const shop_myshopify_domain = req.session.shop.myshopify_domain;
      const shop_myshopify_domain = req.query.shop;
      shopify.generateInternalUrlRequestHash()
      .then((handy_shopify_url_validation_hash)=>{
        let message = encodeURIComponent('error activating billing plan - ' + err.message);
        let query = {handy_shopify_url_validation_hash, shop: shop_myshopify_domain, message};
        
        let queryStringArray = [];
        _.forEach(query, (val, key)=>{
          queryStringArray.push(key + '=' + val);
        })

        const queryString = queryStringArray.join('&');
        const redirectDestination = '/handy/shopify/admin?' + queryString;
        res.redirect(redirectDestination);
        handy.system.log({req, level: 'error', category: 'system', msg: 'error updating billing plan', shop: shop_myshopify_domain, err});
      })
    })
  })

  app.use('/handy/shopify/embed', shopifyEmbedRouter);
}


  /************************************************************************************/
  /****************************** Helper Functions ************************************/
  /************************************************************************************/

// returns {type: {date: {line: value}}}
function getReport(reportType, date, pool) {
  let data;
  switch(reportType){
    case 'customer_count':
      return shopify.analytics.getCustomerCounts(reportType, date, pool)
      .then(({data_return, reportType_return, date_return})=>{
        return new Promise((resolve, reject)=>{
          return resolve({
            [reportType_return]: {
              [date_return.format('M/D/YY')]: data_return
            }
          })
        })
      })
      break;
    case 'customer_adds':
      return shopify.analytics.getCustomerAdds(reportType, date, pool)
      .then(({data_return, reportType_return, date_return})=>{
        return new Promise((resolve, reject)=>{
          return resolve({
            [reportType_return]: {
              [date_return.format('M/D/YY')]: data_return
            }
          })
        })
      })
      break;
    case 'customer_losses':
      return shopify.analytics.getCustomerLosses(reportType, date, pool)
      .then(({data_return, reportType_return, date_return})=>{
        return new Promise((resolve, reject)=>{
          return resolve({
            [reportType_return]: {
              [date_return.format('M/D/YY')]: data_return
            }
          })
        })
      })
      break;
    case 'plan_changes':
      return shopify.analytics.getPlanChanges(reportType, date, pool)
      .then(({data_return, reportType_return, date_return})=>{
        return new Promise((resolve, reject)=>{
          return resolve({
            [reportType]: {
              [date_return.format('M/D/YY')]: data_return
            }
          })
        })
      })
      break;
  }
}