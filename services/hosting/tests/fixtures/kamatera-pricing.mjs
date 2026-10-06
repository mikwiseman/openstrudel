// Selected entries from the official public calculator feed, 2026-10-05.
// It is a public estimate, not an account-specific binding quote.
export const PRICE_SOURCE='https://kamatera.github.io/kamateratoolbox/calculator.js.php';
export const PRICE_IMAGE='7a74bdc0c8034ce9a1fd28d8ed91f8f5';
const option=(description,value,price)=>[{description,options:[{value,description:value,price}]}];
export function pricingCatalog(image=PRICE_IMAGE) {
  return {
    datacenters:['EU'],base:option('base','Base Price',0),cpu:option("Number's of CPU",'1A',0),
    'ramMB.A':option('Amount of memory (MB) for type A(Availability)','2048',0),
    diskGB:option('Total disk size (GB)','20',6),wan:option('Number of IP Addresses','1',0),
    'netPck.EU':option('Network Package EU','t5000',0),managed:option('Management Services (boolean)','0',0),
    // Both values are coefficients. Disabled backup is NOT a 0.5 USD charge.
    backup:[{description:'Backup operation (boolean)',options:[{value:'0',price:0.5},{value:'1',price:0.5}]}],
    os:[{id:image,category:'server',price:0,minRamMB:1024,minCpu:1,minDiskSizeGB:10,imageSizeGB:10,datacenters:['EU']}]
  };
}
export const pricingBody=catalog=>"var prd_prices = '"+JSON.stringify(catalog)+"';";
