var wms_layers = [];


        var lyr_googlehybrid_0 = new ol.layer.Tile({
            'title': 'google hybrid',
            'opacity': 1.000000,
            
            
            source: new ol.source.XYZ({
            attributions: ' ',
                url: 'http://mt0.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}&s=Ga'
            })
        });
var format_poligonos_sirgas_1 = new ol.format.GeoJSON();
var features_poligonos_sirgas_1 = format_poligonos_sirgas_1.readFeatures(json_poligonos_sirgas_1, 
            {dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});
var jsonSource_poligonos_sirgas_1 = new ol.source.Vector({
    attributions: ' ',
});
jsonSource_poligonos_sirgas_1.addFeatures(features_poligonos_sirgas_1);
var lyr_poligonos_sirgas_1 = new ol.layer.Vector({
                declutter: false,
                source:jsonSource_poligonos_sirgas_1, 
                style: style_poligonos_sirgas_1,
                popuplayertitle: 'poligonos_sirgas',
                interactive: true,
    title: 'poligonos_sirgas<br />\
    <img src="styles/legend/poligonos_sirgas_1_0.png" /> Arriendo Victos Muñoz<br />\
    <img src="styles/legend/poligonos_sirgas_1_1.png" /> En trámite Victor Muñoz<br />\
    <img src="styles/legend/poligonos_sirgas_1_2.png" /> <br />' });

lyr_googlehybrid_0.setVisible(true);lyr_poligonos_sirgas_1.setVisible(true);
var layersList = [lyr_googlehybrid_0,lyr_poligonos_sirgas_1];
lyr_poligonos_sirgas_1.set('fieldAliases', {'Id': 'Id', 'Concesion': 'Concesion', 'Status': 'Status', });
lyr_poligonos_sirgas_1.set('fieldImages', {'Id': 'Range', 'Concesion': 'TextEdit', 'Status': 'TextEdit', });
lyr_poligonos_sirgas_1.set('fieldLabels', {'Id': 'no label', 'Concesion': 'no label', 'Status': 'no label', });
lyr_poligonos_sirgas_1.on('precompose', function(evt) {
    evt.context.globalCompositeOperation = 'normal';
});