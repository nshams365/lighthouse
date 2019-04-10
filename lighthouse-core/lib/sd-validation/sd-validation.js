/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const parseJSON = require('./json-linter.js');
const validateJsonLD = require('./jsonld-keyword-validator.js');
const expandAsync = require('./json-expander.js');
const validateSchemaOrg = require('./schema-validator.js');

/**
 * Validates JSON-LD input. Returns array of error objects.
 *
 * @param {string} textInput
 * @returns {Promise<Array<LH.StructuredData.ValidationError>>}
 */
module.exports = async function validate(textInput) {
  // STEP 1: VALIDATE JSON
  const parseError = parseJSON(textInput);

  if (parseError) {
    return [{
      validator: /** @type {LH.StructuredData.ValidatorType} */ ('json'),
      lineNumber: parseError.lineNumber,
      message: parseError.message,
    }];
  }

  const inputObject = JSON.parse(textInput);

  // STEP 2: VALIDATE JSONLD
  const jsonLdErrors = validateJsonLD(inputObject);

  if (jsonLdErrors.length) {
    return jsonLdErrors.map(error => {
      return {
        validator: /** @type {LH.StructuredData.ValidatorType} */ ('json-ld'),
        path: error.path,
        message: error.message,
        lineNumber: getLineNumberFromJsonLDPath(inputObject, error.path),
      };
    });
  }

  // STEP 3: EXPAND
  /** @type {LH.StructuredData.ExpandedSchemaRepresentation|null} */
  let expandedObj = null;
  try {
    expandedObj = await expandAsync(inputObject);
  } catch (error) {
    return [{
      validator: /** @type {LH.StructuredData.ValidatorType} */ ('json-ld-expand'),
      message: error.message,
    }];
  }

  // STEP 4: VALIDATE SCHEMA
  const schemaOrgErrors = validateSchemaOrg(expandedObj);

  if (schemaOrgErrors.length) {
    return schemaOrgErrors.map(error => {
      return {
        validator: /** @type {LH.StructuredData.ValidatorType} */ ('schema-org'),
        path: error.path,
        message: error.message,
        lineNumber: error.path ? getLineNumberFromJsonLDPath(inputObject, error.path) : null,
        invalidTypes: error.invalidTypes,
      };
    });
  }

  return [];
};

/**
 * @param {*} obj
 * @param {string} path
 * @returns {null | number} - line number of the path value in the prettified JSON
 */
function getLineNumberFromJsonLDPath(obj, path) {
  // To avoid having an extra dependency on a JSON parser we set a unique key in the
  // object and then use that to identify the correct line
  const searchKey = Math.random().toString();
  obj = JSON.parse(JSON.stringify(obj));

  setValueAtJsonLDPath(obj, path, searchKey);
  const jsonLines = JSON.stringify(obj, null, 2).split('\n');
  const lineIndex = jsonLines.findIndex(line => line.includes(searchKey));

  return lineIndex === -1 ? null : lineIndex + 1;
}

/**
 * @param {*} obj
 * @param {string} path
 * @param {*} value
 */
function setValueAtJsonLDPath(obj, path, value) {
  const pathParts = path.split('/').filter(p => !!p);
  let currentObj = obj;
  pathParts.forEach((pathPart, i) => {
    if (pathPart === '0' && !Array.isArray(currentObj)) {
      // jsonld expansion turns single values into arrays
      return;
    }

    const isLastPart = pathParts.length - 1 === i;
    let keyFound = false;
    for (const key of Object.keys(currentObj)) {
      // The actual key in JSON might be an absolute IRI like "http://schema.org/author"
      // but key provided by validator is "author"
      const keyParts = key.split('/');
      const relativeKey = keyParts[keyParts.length - 1];
      if (relativeKey === pathPart && currentObj[key] !== undefined) {
        // If we've arrived at the end of the provided path set the value, otherwise
        // continue iterating with the object at the key location
        if (isLastPart) {
          currentObj[key] = value;
        } else {
          currentObj = currentObj[key];
        }
        keyFound = true;
        return;
      }
    }

    if (!keyFound) {
      // Couldn't find the key we got from validation in the original object
      throw Error('Key not found: ' + pathPart);
    }
  });
}
