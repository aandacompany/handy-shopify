'use strict';

let express = require('express')
  , path = require('path')
  , _ = require('underscore')
  , handy = require('@takinola/handy')
  , shopify = require(path.join(__dirname, '..', 'lib', 'handy-shopify' ))
;
const { _uninstallShop } = require('@takinola/handy-shopify')


module.exports = function(app){
  const shopifyRouter = express.Router();
  const webhookRouter = express.Router();
  const shopifyAdminRouter = express.Router();

  // shopify configuration
  shopifyRouter.post('/config', handy.user.isAuthenticated, (req, res)=>{
    delete req.body._csrf;
    let saveType = req.query.saveType;
    let config = {};
    let activeBillingPlans = [];
    let newPlanDefinition;

    _.forEach(req.body, (val, key)=>{
      switch(saveType){
        case 'api':
          switch(key){
            case 'shopify_api_key':
              config[key] = val;
              break;
            case 'shopify_shared_secret':
              config[key]= val;
              break;
            case 'shopify_api_scope':
              config[key] = val;
              break;
            case 'shopify_api_version':
              config[key] = val;
              break;
            case 'shopify_redirect_url':
              config[key] = val;
              break;
          }
          break;
        case 'billing':
          const prefix = 'plan_active_';
          const keySuffix = key.substring(prefix.length);

          if(key.includes(prefix) && !Number.isNaN(Number.parseInt(keySuffix, 10))){
            // key is for modifying an existing billing plan
            activeBillingPlans.push({id: Number.parseInt(keySuffix, 10), active: val});
          }
          break;
      }
    })

    switch(saveType){
      case 'api':

        break;
      case 'billing':
        // check if adding a new billing plan
        const planActive = req.body.plan_active_new !== undefined ? true : false;
        const planName = req.body.plan_name_new;
        const planPrice = Number.parseInt(req.body.plan_price_new, 10);
        const planTrialLength = Number.parseInt(req.body.plan_trial_length_new, 10);
        const planTestStatus = req.body.plan_test_status_new === 'true' ? true : false;
        if(planName && planPrice){
          newPlanDefinition = {name: planName, price: planPrice,
            trial_length: planTrialLength, test: planTestStatus, active: planActive}
        }
        break;
    }


    handy.system.systemGlobal.updateConfig(config)
      .then(()=>{
        switch (saveType){
          case 'api':
            return Promise.resolve();
            break;
          case 'billing':
            // modify existing plans if requested
            let billingPlans = [];
            const existingPlans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans');
            _.forEach(existingPlans, (plan)=>{
              plan.active = false;  // set all plans to inactive
              activeBillingPlans.forEach((activePlan)=>{
                if(plan.id === activePlan.id){plan.active = true}
              })

              billingPlans.push({id: plan.id, name: plan.name, price: plan.price, term: plan.term,
                trial_length: plan.trial_length, test: plan.test, deleted: plan.deleted, active: plan.active});
            })


            const promiseFactory = (updatePlanDefinition)=>{
              let updatePlan = new shopify.Plan(updatePlanDefinition);
              return updatePlan.save()
                .then(()=>{
                  // add plans to global object
                  let savedPlans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans') || {};
                  savedPlans[updatePlan.id] = updatePlan;

                  return handy.system.systemGlobal.updateConfig({shopify_app_billing_plans: savedPlans});
                });
            }

            let promiseChain = Promise.resolve();
            billingPlans.forEach((billingPlan)=>{
              promiseChain = promiseChain.then(()=> promiseFactory(billingPlan))
            })

            return promiseChain;
            break;
        }
      })
      .then(()=>{
        switch(saveType){
          case 'api':
            return Promise.resolve();
            break;
          case 'billing':
            // create a new plan if required
            if(newPlanDefinition){
              let newPlan = new shopify.Plan(newPlanDefinition);
              return newPlan.save()
                .then(()=>{
                  // add plans to global object
                  let savedPlans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans') || {};
                  savedPlans[newPlan.id] = newPlan;
                  return handy.system.systemGlobal.updateConfig({shopify_app_billing_plans: savedPlans});
                });
            } else {
              return Promise.resolve();
            }
            break;
        }
      })
      .then(()=> {
        const alert = {type: 'success', text: 'configuration updated successfully'};
        handy.system.systemMessage.set(alert, req, res);
        res.redirect('back');
        handy.system.log({req, level: 'info', category: 'system', msg: 'shopify configuration updated', user: req.session.user.id});
      })
      .catch((err)=>{
        const alert = {type: 'danger', text: 'something went wrong updating shopify configuration - ' + err.message};
        handy.system.systemMessage.set(alert, req, res);
        res.redirect('back');
        handy.system.log({req, level: 'error', category: 'system', msg: 'error updating shopify configuration', user: req.session.user.id});
      });
  })


  // re-route installation sequence where user does not automatically provide the shop name
  shopifyRouter.post('/install', (req, res)=>{
    const shop = req.body.shopify_shop_domain + '.myshopify.com';
    res.redirect('/handy/shopify/admin?shop='+ shop);
    handy.system.log({req, level: 'info', category: 'system', msg: 'rerouting to install sequence', shop});
  })


  // emulations ie config settings to make shops behave differently than they would
  shopifyRouter.post('/emulate/:emulation', (req, res)=>{
    /*
     * NOTE: Billing plan emulations are handled differently than other shop property emulations
     * Even though billing_plan is not a direct property of the Shop object, it is registered as
     * a direct property of the emulations object for convenience
     */
    const myshopify_domain = req.body.shop;
    const emulation = req.params.emulation;
    const emulated_value = req.body.emulated_value;

    if(!emulation || !myshopify_domain){
      const alert = {type: 'danger', text: 'emulation specification is required'};
      handy.system.systemMessage.set(alert, req, res);
      res.redirect('back');
      handy.system.log({req, level: 'error', category: 'system', msg: 'error setting emulation - missing field', user: req.session.user.id, shop: myshopify_domain});
    }

    let emulateShop = new shopify.Shop({myshopify_domain});
    emulateShop.load('myshopify_domain')
      .then(()=>{
        emulateShop.emulations = emulateShop.emulations || {};
        if(req.body.emulated_value !== null && req.body.emulated_value !== ''){
          emulateShop.emulations[emulation] = emulated_value;
        } else {
          delete emulateShop.emulations[emulation];
        }

        return emulateShop.save();
      })
      .then(()=> {
        const alert = {type: 'success', text: 'emulation updated successfully'};
        handy.system.systemMessage.set(alert, req, res);
        res.redirect('back');
        handy.system.log({req, level: 'info', category: 'system', msg: 'shop emulation updated', user: req.session.user.id, shop: myshopify_domain});
      })
      .catch((err)=>{
        const alert = {type: 'danger', text: 'something went wrong updating shop emulation - ' + err.message};
        handy.system.systemMessage.set(alert, req, res);
        res.redirect('back');
        handy.system.log({req, level: 'error', category: 'system', msg: 'error updating shop emulation', user: req.session.user.id, shop: myshopify_domain});
      });
  })


  /**********************************************************************/
  /* shop administration panel i.e. /handy/shopify/listshops/:shopname? */
  /**********************************************************************/
  shopifyRouter.post('/updateShopThemeAssets', handy.user.isAuthenticated, (req, res)=>{
    const myshopify_domain = req.body.shop;
    const event = 'themes_publish';
    _themesUpdateThemesPublish(event, myshopify_domain, req, res);
  })

  // helper function for routes '/handy/shopify/updateShopThemeAssets'
  function _themesUpdateThemesPublish(event, myshopify_domain, req, res){
    // insert into queue for processing
    const queueType = 'shopifyWebhook'
      , queueLockStatus = false
    ;

    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
      .then(()=>{
        const payload = {
          event: event,
          shop: JSON.stringify(shop),
        }

        return handy.system.insertQueueItem(queueType, queueLockStatus, payload)
      })
      .then(()=>{
        return res.redirect('back');
      })
      .catch((err)=>{
        return res.status(500).send();
      })
  }

  shopifyRouter.post('/updateShopWebhooks', handy.user.isAuthenticated, (req, res)=>{
    const myshopify_domain = req.body.shop;

    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
      .then(()=>shop.resetWebhooks())
      .then(({alert, msg})=>{
        handy.system.systemMessage.set(alert, req, res);
        res.redirect('back');
        handy.system.log({req, level: 'info', category: 'system', msg, user: req.session.user.id});
      })
      .catch((err)=>{
        const alert = {type: 'danger', text: 'something went wrong updating shop webhooks - ' + err.message};
        handy.system.systemMessage.set(alert, req, res);
        res.redirect('back');
        handy.system.log({req, level: 'error', category: 'system', msg: 'error updating shop webhooks', user: req.session.user.id});
      })
  })


  shopifyRouter.post('/updateShopScriptTags', handy.user.isAuthenticated, (req, res)=>{
    const myshopify_domain = req.body.shop;
    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
      .then(()=> shop.resetScriptTags())
      .then(({alert, msg})=>{
        handy.system.systemMessage.set(alert, req, res);
        res.redirect('back');
        handy.system.log({req, level: 'info', category: 'system', msg, user: req.session.user.id});
      })
      .catch((err)=>{
        const alert = {type: 'danger', text: 'something went wrong updating shop script tags - ' + err.message};
        handy.system.systemMessage.set(alert, req, res);
        res.redirect('back');
        handy.system.log({req, level: 'error', category: 'system', msg: 'error updating shop script tags', user: req.session.user.id });
      })
  })

  /***************************************************************************/
  /* end: shop administration panel i.e. /handy/shopify/listshops/:shopname? */
  /***************************************************************************/


  app.use('/handy/shopify', shopifyRouter);


  /************************************************************************************************/
  /**************************************** Webhooks **********************************************/
  /************************************************************************************************/

  // webhook authentication middleware
  webhookRouter.use(shopify.authenticateWebhook)

  // uninstall app webhook
  webhookRouter.post('/app_uninstalled', (req, res)=>{
    res.status(200).send({done:true});
    const myshopify_domain = req.headers['x-shopify-shop-domain'];
    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
      .then(()=>{
        const queueType = 'shopifyWebhook'
          , queueLockStatus = false
        ;

        const payload = {
          event: 'app_uninstalled',
          shop: JSON.stringify(shop)
        }

        // instead adding job (deleting store) to queue, we do it (run job) right now (to prevent issue with gap when shop can't be reinstalled)
        return _uninstallShop(shop)
        // return handy.system.insertQueueItem(queueType, queueLockStatus, payload);
      })
      .then(()=>{
        handy.system.log({req, level: 'info', category: 'system', msg: 'webhook - app_uninstalled handler success', shop: shop.myshopify_domain});
      })
      .catch((err)=>{
        handy.system.log({req, level: 'error', category: 'system', msg: 'webhook - app_uninstalled handler error', shop: shop.myshopify_domain, err});
      })
  })

  // shop update webhook
  webhookRouter.post('/shop_update', (req,res)=>{
    const myshopify_domain = req.headers['x-shopify-shop-domain']
      , {address1, address2, city, province, province_code, zip, country_code, country, email, phone} = req.body
      , {domain, money_format, currency} = req.body
      , owner = req.body.shop_owner
      , shopify_plan = req.body.plan_name
      , shopify_created_at = req.body.created_at
      , shopify_updated_at = req.body.updated_at
    ;

    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
      .then(()=>{
        shop.address1 = address1;
        shop.address2 = address2;
        shop.city = city;
        shop.province = province;
        shop.province_code = province_code;
        shop.zip = zip;
        shop.country_code = country_code;
        shop.country = country;
        shop.email = email;
        shop.phone = phone;
        shop.domain = domain;
        shop.myshopify_domain = myshopify_domain;
        shop.money_format = money_format;
        shop.currency = currency;
        shop.owner = owner;
        shop.shopify_plan = shopify_plan;
        shop.shopify_created_at = shopify_created_at;
        shop.shopify_updated_at = shopify_updated_at;

        const queueType = 'shopifyWebhook'
          , queueLockStatus = false
        ;

        const payload = {
          event: 'shop_update',
          shop: JSON.stringify(shop)
        }

        return handy.system.insertQueueItem(queueType, queueLockStatus, payload);
      })
      .then(()=>{
        res.status(200).send();
        handy.system.log({req, level: 'info', category: 'system', msg: 'webhook - shop_update handler success', shop: shop.myshopify_domain});
      })
      .catch((err)=>{
        res.status(500).send();
        handy.system.log({req, level: 'error', category: 'system', msg: 'webhook - shop_update handler error', shop: shop.myshopify_domain, err});
      })
  })

  // customer data erasure webhook
  webhookRouter.post('/redact_customer_data', (req, res)=>{
    const myshopify_domain = req.headers['x-shopify-shop-domain'];
    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
      .then(()=>{
        const queueType = 'shopifyWebhook'
          , queueLockStatus = false
        ;

        const customer = req.body.customer || {} // {id: , email: , phone: } may only contain email
          , orders = req.body.orders_to_redact || [] // [order_id_1, order_id_2, etc]
        ;

        const payload = {
          event: 'redact_customer_data',
          shop: JSON.stringify(shop),
          customer,
          orders,
        }

        return handy.system.insertQueueItem(queueType, queueLockStatus, payload);
      })
      .then(()=>{
        res.status(200).send();
        handy.system.log({req, level: 'info', category: 'system', msg: 'webhook - redact_customer_data handler success', shop: shop.myshopify_domain});
      })
      .catch((err)=>{
        res.status(500).send();
        handy.system.log({req, level: 'error', category: 'system', msg: 'webhook - redact_customer_data handler error', shop: shop.myshopify_domain, err});
      })
  })

  // shop data erasure webhook
  webhookRouter.post('/redact_shop_data', (req, res)=>{
    const myshopify_domain = req.headers['x-shopify-shop-domain'];
    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
      .then(()=>{
        const queueType = 'shopifyWebhook'
          , queueLockStatus = false
        ;

        const payload = {
          event: 'redact_shop_data',
          shop: JSON.stringify(shop)
        };

        return handy.system.insertQueueItem(queueType, queueLockStatus, payload);
      })
      .then(()=>{
        res.status(200).send();
        handy.system.log({req, level: 'info', category: 'system', msg: 'webhook - redact_shop_data handler success', shop: shop.myshopify_domain});
      })
      .catch((err)=>{
        res.status(500).send();
        handy.system.log({req, level: 'error', category: 'system', msg: 'webhook - redact_shop_data handler error', shop: shop.myshopify_domain, err});
      })
  })

  // customer data request webhook
  webhookRouter.post('/request_customer_data', (req, res)=>{
    const myshopify_domain = req.headers['x-shopify-shop-domain'];
    let shop = new shopify.Shop({myshopify_domain});
    shop.load('myshopify_domain')
      .then(()=>{
        const queueType = 'shopifyWebhook'
          , queueLockStatus = false
        ;

        const customer = req.body.customer || {} // {id: , email: , phone: } may only contain email
          , orders = req.body.orders_requested || [] // [order_id_1, order_id_2, etc]
        ;

        const payload = {
          event: 'request_customer_data',
          shop: JSON.stringify(shop),
          customer,
          orders,
        }

        return handy.system.insertQueueItem(queueType, queueLockStatus, payload);
      })
      .then(()=>{
        res.status(200).send();
        handy.system.log({req, level: 'info', category: 'system', msg: 'webhook - request_customer_data handler success', shop: shop.myshopify_domain});
      })
      .catch((err)=>{
        res.status(500).send();
        handy.system.log({req, level: 'error', category: 'system', msg: 'webhook - request_customer_data handler error', shop: shop.myshopify_domain, err});
      })
  })



  const webhooks_base_path = handy.system.systemGlobal.get('webhooks_base_path');
  app.use(webhooks_base_path, webhookRouter);



  /************************************************************************************************/
  /************************************** Shopify Admin *******************************************/
  /************************************************************************************************/

  // use session token verifiction middleware only on POST requests
  shopifyAdminRouter.use((req, res, next)=>{
    if(req.method.toLowerCase() === 'get'){
      return next();
    } else {
      return shopify.authenticateJWT(req, res, next);
    }
  });

  // initiate billing plan change
  shopifyAdminRouter.post('/plan', (req, res)=>{
    _.forEach(req.body, (val, key)=>{
      req.body[key] = decodeURIComponent(val);
    })

    const {plan} = req.body;
    if(!plan){
      return res.status(500).send(JSON.stringify({err: new Error('valid plan name required')}))
    }

    // for security reasons, identify shop from session token
//    const myshopify_domain = req.session.shop.myshopify_domain;
    const myshopify_domain = req.myshopify_domain;
    let shop = new shopify.Shop({myshopify_domain});
    let redirect_url;  // url to send user after processing
    let display_message; // message to display to user

    shop.load('myshopify_domain')
      .then(()=>shop.createRecurringCharge(plan))
      .then((redirect_url)=>{
        res.status(200).send(JSON.stringify({redirect_url}))
        handy.system.log({req, level: 'info', category: 'system', msg: 'billing plan change initiated', shop: shop.myshopify_domain, plan});
      })
      .catch((err)=>{
        res.status(500).send(JSON.stringify({err: err.message}));
        handy.system.log({req, level: 'error', category: 'system', msg: 'billing plan change error', shop: shop.myshopify_domain, err, plan});
      })
  })


  // send email
  shopifyAdminRouter.post('/sendmail', (req, res)=>{
    _.forEach(req.body, (val, key)=>{
      req.body[key] = decodeURIComponent(val);
    })

    let {to, from, subject, text} = req.body;
    from = handy.system.systemGlobal.getConfig('siteEmail');
    const attachment = [{data: text, alternative: true}];
    handy.system.createEmailQueueItem({from, to, subject, text, attachment})
      .then(()=>{
        res.status(200).send(JSON.stringify({message: 'message successfully queued'}));
        handy.system.log({req, level: 'info', category: 'system', msg: 'email successfully queued', from, to, subject});
      })
      .catch((err)=>{
        res.status(500).send(JSON.stringify({message: 'error sending message to queue - ' + err.message}));
        handy.system.log({req, level: 'error', category: 'system', msg: 'email queuing failed', err});
      })
  })


  // create event log
  shopifyAdminRouter.post('/logevent', (req, res)=>{
    const level = req.body.level || 'info';
    const category = req.body.category || 'system';
    const msg = req.body.msg || '';
    // identify shop from session cookie for security reasons
//    const shop = req.session.shop.myshopify_domain;
    const shop = req.myshopify_domain;
    res.status(200).send(JSON.stringify({message: 'event logged successfully'}));
    handy.system.log({req, level, category, msg, shop});
  })


  // dismiss admin notifications
  shopifyAdminRouter.post('/canceladminnotification', (req, res)=>{
    let {type, ids, shop} = req.body;
    ids = ids.split(',');

    let notificationShop = new shopify.Shop({myshopify_domain: shop})
    notificationShop.load('myshopify_domain')
      .then(()=> notificationShop.cancelAdminNotification({cancelType: type, ids}))
      .then(()=>{
        res.status(200).send(JSON.stringify({message: 'notifications cancelled successfully'}));
        handy.system.log({req, level: 'info', category: 'system', msg: 'admin notifications cancelled', shop: shop.myshopify_domain});
      })
      .catch((err)=>{
        res.status(500).send(JSON.stringify({message: 'error cancelling admin notifications ' + err.message}));
        handy.system.log({req, level: 'error', category: 'system', msg: 'admin notification cancellation failed - ' + err.message, shop: shop.myshopify_domain});
      })
  })



  app.use('/handy/shopify/admin', shopifyAdminRouter);
}
