const handy = require('@takinola/handy')
  , _ = require('underscore')
  , path = require('path')
  , shopify = require(path.join(__dirname, 'handy-shopify'))
  , errorHandling = require(path.join(__dirname, 'error-handling'))
  ;

/*
 * Product object
 *
 * @api public
 */

class Product extends handy.system.BaseClass {
  constructor({id=null, shopify_product_id=null, shopify_gql_product_id=null, shopify_variant_id=null, shopify_gql_variant_id=null, 
    title=null, price=null, inventory_item_id=null, inventory_quantity=null, body_html=null, handle=null, product_type=null, 
    tags=null, vendor=null, myshopify_domain=null}, runtimeExtension=[]){

    const tableDefinition = {
      name: 'products',
      columns: [
        {name: 'shopify_product_id', type: 'VARCHAR(48)'},
        {name: 'shopify_gql_product_id', type: 'VARCHAR(60)'},
        {name: 'shopify_variant_id', type: 'VARCHAR(48)'},
        {name: 'shopify_gql_variant_id', type: 'VARCHAR(60)'},
        {name: 'title', type: 'VARCHAR(512)'},
        {name: 'price', type: 'VARCHAR(512)'},
        {name: 'inventory_item_id', type: 'VARCHAR(60)'},
        {name: 'inventory_quantity', type: 'BIGINT'},
        {name: 'body_html', type: 'VARCHAR(2048)'},
        {name: 'handle', type: 'VARCHAR(512)'},
        {name: 'product_type', type: 'VARCHAR(512)'},
        {name: 'tags', type: 'VARCHAR(512)'},
        {name: 'vendor', type: 'VARCHAR(512)'},
        {name: 'myshopify_domain', type: 'VARCHAR(4096)', index: true},
      ],
    }

    super({id, shopify_product_id, shopify_gql_product_id, shopify_variant_id, shopify_gql_variant_id, title, price, inventory_item_id, 
      inventory_quantity, body_html, handle, product_type, tags, vendor, myshopify_domain}, tableDefinition, runtimeExtension)

    this.shopify_product_id = shopify_product_id;
    this.shopify_gql_product_id = shopify_gql_product_id;
    this.shopify_variant_id = shopify_variant_id;
    this.shopify_gql_variant_id = shopify_gql_variant_id;
    this.title = title;
    this.price = price;
    this.inventory_item_id = inventory_item_id;
    this.inventory_quantity = inventory_quantity;
    this.body_html = body_html;
    this.handle = handle;
    this.product_type = product_type;
    this.tags = tags;
    this.vendor = vendor;
    this.myshopify_domain = myshopify_domain;
  }


  createShopifyAPI(){
    // if this.Shopify exists already then just return
    return new Promise((resolve, reject)=>{
      if(this.Shopify){return resolve();}

      let productShop = new shopify.Shop({myshopify_domain: this.myshopify_domain});
      productShop.load('myshopify_domain')
      .then(()=>{
        this.access_token = productShop.access_token;
        this.nonce = productShop.nonce;
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

  // get the details of the product from Shopify
  getProductDetail({fields=[]}){
    return this.createShopifyAPI()
    .then(()=>{
      return new Promise((resolve, reject)=>{
        const shopify_api_version = handy.system.systemGlobal.getConfig('shopify_api_version');
        const query = fields.length ? '?fields=' + fields.join(',') : '';
        this.Shopify.get('/admin/api' + shopify_api_version + '/products/' + this.shopify_product_id + '.json' + query, (err, data, headers)=>{
          if(err){return reject(new Error('error getting product details from Shopify - ' + errorHandling.getErrorMessage(err)))}
          return resolve(data.product);
        })
      })
    })
  }
}

exports.Product = Product;
