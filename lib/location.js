const handy = require('@takinola/handy')
  , shopifyAPI = require('shopify-node-api')
  , path = require('path')
  , shopify = require(path.join(__dirname, 'handy-shopify'))
  , _ = require('underscore')
  , errorHandling = require(path.join(__dirname, 'error-handling'))

  ;

/*
 * Location object
 *
 * @api public
 */
class Location extends handy.system.BaseClass {
  constructor({id=null, shopify_location_id=null, shopify_gql_location_id=null, active=false, address1=null, address2=null, 
    city=null, country=null, country_code=null, legacy=false, name=null, 
    phone=null, province=null, province_code=null, zip=null, myshopify_domain}, runtimeExtension=[]){

    const tableDefinition = {
      name: 'locations',
      columns: [
        {name: 'shopify_location_id', type: 'VARCHAR(48)'},
        {name: 'shopify_gql_location_id', type: 'VARCHAR(60)'},
        {name: 'active', type: 'BOOLEAN', default: false, datatype: 'boolean'},
        {name: 'address1', type: 'VARCHAR(512)'},
        {name: 'address2', type: 'VARCHAR(512)'},
        {name: 'city', type: 'VARCHAR(512)'},
        {name: 'province', type: 'VARCHAR(512)'},
        {name: 'province_code', type: 'VARCHAR(8)'},
        {name: 'zip', type: 'VARCHAR(16)'},
        {name: 'country_code', type: 'VARCHAR(16)'},
        {name: 'country', type: 'VARCHAR(512)'},
        {name: 'phone', type: 'VARCHAR(32)'},
        {name: 'legacy', type: 'BOOLEAN', default: false, datatype: 'boolean'},
        {name: 'name', type: 'VARCHAR(512)'},
        {name: 'myshopify_domain', type: 'VARCHAR(4096)', index: true},
      ]
    }

    super({id, shopify_location_id, shopify_gql_location_id, active, address1, address2, city, province,
      province_code, zip, country_code, country, phone, legacy, name, myshopify_domain}, tableDefinition, runtimeExtension)

    this.shopify_location_id = shopify_location_id;
    this.shopify_gql_location_id = shopify_gql_location_id;
    this.active = active;
    this.address1 = address1;
    this.address2 = address2;
    this.city = city;
    this.province = province;
    this.province_code = province_code;
    this.zip = zip;
    this.country_code = country_code;
    this.country = country;
    this.phone = phone;
    this.legacy = legacy;
    this.name = name;
    this.myshopify_domain = myshopify_domain;
  }


  createShopifyAPI(){
    // if this.Shopify exists already then just return
    return new Promise((resolve, reject)=>{
      if(this.Shopify){return resolve();}

      let locationShop = new shopify.Shop({myshopify_domain: this.myshopify_domain});
      locationShop.load('myshopify_domain')
      .then(()=>{
        this.access_token = locationShop.access_token;
        this.nonce = locationShop.nonce;
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

        this.Shopify = new shopifyAPI(shopifyConfig);
        return resolve();   
      })
    })
  }

  connectInventory(items=[]){
    this.createShopifyAPI()
    .then(()=>{
      const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
      if(!Array.isArray(items)){
        items = [items];
      }

      const promiseFactory = (item)=>{
        return new Promise((resolve, reject)=>{
          const payload = {
            location_id: this.shopify_location_id,
            inventory_item_id: item
          }

          this.Shopify.post(`/admin/api/${shopify_api_version}/inventory_levels/connect.json`, payload, (err, data, headers)=>{
            if(err){return reject(new Error(`error connecting location to inventory item - ${errorHandling.getErrorMessage(err)}`))};
            if(data.errors){return reject (new Error(`error connecting location to inventory item - ${JSON.stringify(data.errors)}`))};
            return resolve();
          })
        })
      }

      let promiseChain = Promise.resolve();

      items.forEach((item)=>{
        promiseChain = promiseChain.then(()=> promiseFactory(item))
      })

      return promiseChain; 
    })
    .catch(err=> Promise.reject(err))
  }
}

exports.Location = Location;
