    // Inicializacija
    const map = L.map('map').setView([54.6872, 25.2797], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(map);

    let initialMarkersGroup = L.layerGroup().addTo(map);
    let routeMarkersGroup = L.layerGroup().addTo(map);
    let routingControl = null;
    let searchTimeout = null;
    let startPoint = null;
    let isRouteCurrentlyBuilt = false; // ИЗМЕНЕНИЕ: Переменная для отслеживания статуса маршрута
    let gpsState = 0; // 0 - выключено, 1 - точка поставлена, 2 - включен LIVE
    let gpsWatchId = null;       // Сюда запишется ID постоянного слежения, чтобы его можно было выключить
    let userLocationMarker = null; // Отдельный маркер для текущего положения водителя
    

    // Drag-and-Drop
    const list = document.getElementById('address-list');
    Sortable.create(list, {
        handle: '.drag-handle',
        animation: 150,
        onEnd: () => { 
            updateListState(); 
            refreshInitialMarkers(); 
            // ИЗМЕНЕНИЕ: Если маршрут уже был построен, перестраиваем его при перетаскивании
            if (isRouteCurrentlyBuilt) {
                buildFinalRoute(false); // false означает "не скроллить экран вверх"
            } else {
                saveDataToLocalStorage(); 
            }
        }
    });

    // Функция сохранения данных в localStorage
    function saveDataToLocalStorage() {
        const items = [];
        document.querySelectorAll('.address-item').forEach(item => {
            items.push({
                title: item.getAttribute('data-title'),
                lat: parseFloat(item.getAttribute('data-lat')),
                lng: parseFloat(item.getAttribute('data-lng'))
            });
        });

        const dataToSave = {
            startPoint: startPoint,
            deliveryAddresses: items,
            routeBuilt: isRouteCurrentlyBuilt // ИЗМЕНЕНИЕ: Сохраняем статус линии маршрута
        };

        localStorage.setItem('adpakas_route_data', JSON.stringify(dataToSave));
    }

    // Функция загрузки данных из localStorage при открытии
    function loadDataFromLocalStorage() {
        const savedData = localStorage.getItem('adpakas_route_data');
        if (!savedData) return;

        try {
            const data = JSON.parse(savedData);
            
            // Восстанавливаем стартовую точку
            if (data.startPoint) {
                startPoint = data.startPoint;
                document.getElementById('start-point-text').innerText = startPoint.title;
                document.getElementById('start-point-display').style.display = 'flex';
            }

            // Восстанавливаем адреса доставки
            if (data.deliveryAddresses && data.deliveryAddresses.length > 0) {
                const listContainer = document.getElementById('address-list');
                data.deliveryAddresses.forEach(addr => {
                    const li = document.createElement('li');
                    li.className = 'address-item';
                    li.setAttribute('data-lat', addr.lat);
                    li.setAttribute('data-lng', addr.lng);
                    li.setAttribute('data-title', addr.title);

                    li.innerHTML = `
                        <div class="drag-handle">☰</div>
                        <div class="address-content">
                            <div class="address-title">${addr.title}</div>
                            <div class="address-meta">Koord.: ${addr.lat.toFixed(4)}, ${addr.lng.toFixed(4)}</div>
                        </div>
                        <div class="address-actions">
                            <select class="position-select" onchange="changePosition(this)"></select>
                            <button class="delete-btn" onclick="deleteItem(this)">×</button>
                        </div>
                    `;
                    listContainer.appendChild(li);
                });
            }

            // Обновляем интерфейс
            if (startPoint || (data.deliveryAddresses && data.deliveryAddresses.length > 0)) {
                updateListState();
                refreshInitialMarkers();
                
                // ИЗМЕНЕНИЕ: Если до перезагрузки маршрут был построен, строим его автоматически
                if (data.routeBuilt && startPoint && data.deliveryAddresses.length > 0) {
                    buildFinalRoute(false); // Строим без анимации скролла
                } else {
                    // Иначе просто центрируем карту
                    if (startPoint) {
                        map.setView([startPoint.lat, startPoint.lng], 12);
                    } else if (data.deliveryAddresses.length > 0) {
                        map.setView([data.deliveryAddresses[0].lat, data.deliveryAddresses[0].lng], 12);
                    }
                }
            }
        } catch (e) {
            console.error("Klaida įkeliant išsaugotus duomenis:", e);
        }
    }

    // Pataisyta meniu perjungimo logika
    function toggleSidebar() {
        const body = document.body;
        const btn = document.getElementById('toggle-sidebar-btn');
        const sidebar = document.getElementById('sidebar');
        const mapDiv = document.getElementById('map');
        const isMobile = window.innerWidth <= 768;
        
        body.classList.toggle('sidebar-hidden');
        
        if (body.classList.contains('sidebar-hidden')) {
            btn.innerHTML = '📝 Rodyti meniu';
            if (isMobile) {
                sidebar.style.display = 'none';
                mapDiv.style.height = '100vh';
            }
        } else {
            btn.innerHTML = '🗺️ Paslėpti meniu';
            if (isMobile) {
                sidebar.style.display = 'flex';
                mapDiv.style.height = '40vh';
            }
        }
        
        setTimeout(() => {
            map.invalidateSize({ animate: true });
        }, 300);
    }

    window.addEventListener('resize', () => {
        const isMobile = window.innerWidth <= 768;
        const sidebar = document.getElementById('sidebar');
        const mapDiv = document.getElementById('map');
        const bodyHidden = document.body.classList.contains('sidebar-hidden');

        if (!isMobile) {
            sidebar.style.display = 'flex';
            mapDiv.style.height = '100%';
        } else {
            if (bodyHidden) {
                sidebar.style.display = 'none';
                mapDiv.style.height = '100vh';
            } else {
                sidebar.style.display = 'flex';
                mapDiv.style.height = '40vh';
            }
        }
        map.invalidateSize();
    });

    function debounceSearch(value, type) {
        clearTimeout(searchTimeout);
        const boxId = type === 'start' ? 'start-suggestions' : 'suggestions';
        const suggestionsBox = document.getElementById(boxId);
        
        if (value.trim().length < 3) {
            suggestionsBox.style.display = 'none';
            return;
        }

        searchTimeout = setTimeout(() => {
            fetchSuggestions(value, type);
        }, 300);
    }

    function fetchSuggestions(query, type) {
    const boxId = type === 'start' ? 'start-suggestions' : 'suggestions';
    const suggestionsBox = document.getElementById(boxId);
    
    // ОПТИМИЗАЦИЯ ЗАПРОСА: 
    // viewbox=20.9,56.5,26.9,53.8 — это географические границы Литвы.
    // bounded=1 — принудительно заставляет искать ИМЕННО внутри этих границ.
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=lt&addressdetails=1&accept-language=lt&limit=7&viewbox=20.9,56.5,26.9,53.8&bounded=1`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            suggestionsBox.innerHTML = '';

            if (data && data.length > 0) {
                data.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'suggestion-item';
                    
                    const addr = item.address;
                    let placeName = item.name || '';
                    
                    const street = addr.road || addr.pedestrian || addr.cycleway || '';
                    const house = addr.house_number || '';
                    const city = addr.city || addr.town || addr.village || addr.municipality || '';
                    const suburb = addr.suburb || addr.neighbourhood || '';
                    
                    let addressParts = [];
                    
                    if (placeName && placeName !== street && placeName !== city) {
                        addressParts.push(placeName);
                    }
                    if (street) {
                        addressParts.push(street + (house ? ' ' + house : ''));
                    }
                    if (suburb) addressParts.push(suburb);
                    if (city) addressParts.push(city);

                    let cleanAddress = addressParts.filter(Boolean).join(', ');
                    
                    // ЗАПАСНОЙ ПЛАН: Если склеенный адрес пустой или слишком короткий, 
                    // берем полное имя от сервера (убирая "Lietuva" для красоты)
                    if (!street || !cleanAddress || cleanAddress.length < 6) {
                        cleanAddress = item.display_name.replace(', Lietuva', '');
                    }

                    div.innerText = cleanAddress;
                    
                    div.onclick = () => {
                        if (type === 'start') {
                            setStartPoint(cleanAddress, parseFloat(item.lat), parseFloat(item.lon));
                        } else {
                            addAddressToList(cleanAddress, parseFloat(item.lat), parseFloat(item.lon));
                        }
                        suggestionsBox.style.display = 'none';
                        const inputId = type === 'start' ? 'start-input' : 'address-input';
                        document.getElementById(inputId).value = '';
                    };
                    suggestionsBox.appendChild(div);
                });
                suggestionsBox.style.display = 'block';
            } else {
                suggestionsBox.style.display = 'none';
            }
        })
        .catch(() => {});
}

    function setStartPoint(title, lat, lng) {
        clearRouteLine();
        startPoint = { title, lat, lng };
        document.getElementById('start-point-text').innerText = title;
        document.getElementById('start-point-display').style.display = 'flex';
        map.setView([lat, lng], 13);
        refreshInitialMarkers();
        updateListState();
        saveDataToLocalStorage(); 
    }

    function addAddressToList(title, lat, lng) {
        clearRouteLine();

        const li = document.createElement('li');
        li.className = 'address-item';
        li.setAttribute('data-lat', lat);
        li.setAttribute('data-lng', lng);
        li.setAttribute('data-title', title);

        li.innerHTML = `
            <div class="drag-handle">☰</div>
            <div class="address-content">
                <div class="address-title">${title}</div>
                <div class="address-meta">Koord.: ${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
            </div>
            <div class="address-actions">
                <select class="position-select" onchange="changePosition(this)"></select>
                <button class="delete-btn" onclick="deleteItem(this)">×</button>
            </div>
        `;

        document.getElementById('address-list').appendChild(li);
        map.setView([lat, lng], 13);
        refreshInitialMarkers();
        updateListState();
        saveDataToLocalStorage(); 
    }

    function updateListState() {
        const items = document.querySelectorAll('.address-item');
        const total = items.length;
        document.getElementById('count').innerText = `${total} gavėjų`;
        document.getElementById('route-btn').disabled = !(startPoint && total >= 1);

        items.forEach((item, index) => {
            const select = item.querySelector('.position-select');
            select.innerHTML = '';
            for (let i = 1; i <= total; i++) {
                let opt = document.createElement('option');
                opt.value = i; opt.innerText = i;
                if (i === (index + 1)) opt.selected = true;
                select.appendChild(opt);
            }
        });
    }
    // Nauja funkcija: Visiškas Starto pozicijos (A taško) pašalinimas
    function deleteStartPoint() {
        if (confirm("Ar tikrai norite pašalinti starto poziciją (A tašką)?")) {
            // 1. Стираем линию маршрута с карты, так как без старта его быть не может
            clearRouteLine();
            
            // 2. Сбрасываем переменную старта в null
            startPoint = null;
            
            // 3. Прячем блок отображения на панели и очищаем текст
            document.getElementById('start-point-display').style.display = 'none';
            document.getElementById('start-point-text').innerText = '';
            
            // 4. Обновляем счетчики и блокируем кнопку "Sukurti maršrutą"
            updateListState();
            
            // 5. Перерисовываем маркеры на карте (останутся только точки доставки)
            refreshInitialMarkers();
            
            // 6. Сохраняем пустой старт в память браузера (localStorage)
            saveDataToLocalStorage();
        }
    }

    function changePosition(selectElement) {
        clearRouteLine();
        const itemToMove = selectElement.closest('.address-item');
        const targetPosition = parseInt(selectElement.value) - 1;
        const listContainer = document.getElementById('address-list');
        
        listContainer.removeChild(itemToMove);
        const currentItems = document.querySelectorAll('.address-item');
        
        if (targetPosition >= currentItems.length) {
            listContainer.appendChild(itemToMove);
        } else {
            listContainer.insertBefore(itemToMove, currentItems[targetPosition]);
        }
        updateListState();
        refreshInitialMarkers();
        
        // ИЗМЕНЕНИЕ: Если маршрут уже был на экране, автоматически перестраиваем его с учетом нового порядка
        if (isRouteCurrentlyBuilt) {
            buildFinalRoute(false);
        } else {
            saveDataToLocalStorage();
        }
    }

    function deleteItem(buttonElement) {
        if (confirm("Ar tikrai norite pašalinti šį adresą iš maršruto?")) {
            clearRouteLine();
            buttonElement.closest('.address-item').remove();
            updateListState();
            refreshInitialMarkers();
            saveDataToLocalStorage(); 
        }
    }

    // Функция удаления адреса при клике на кнопку внутри маркера на карте
    function deleteItemByIndex(index) {
    const items = document.querySelectorAll('.address-item');
    if (items[index] && confirm("Ar tikrai norite pašalinti šį adresą iš maršruto?")) {
        clearRouteLine();
        items[index].remove(); // Удаляем элемент из HTML-списка
        
        updateListState();
        refreshInitialMarkers();
        saveDataToLocalStorage();
        
        // Если до удаления был включен LIVE режим, и в нем была машина,
        // мы восстанавливаем трекинг, чтобы он не сбросился
        if (gpsState === 2 && userLocationMarker !== null) {
            const currentLatLng = userLocationMarker.getLatLng();
            userLocationMarker.addTo(map); // Возвращаем машину на карту
        }
    }
}

    function refreshInitialMarkers() {
    initialMarkersGroup.clearLayers();
    if (startPoint) {
        const startIcon = L.divIcon({ className: 'number-marker start-marker', html: 'S' });
        const popupContent = `<b>Pradžia:</b> ${startPoint.title}`;
        L.marker([startPoint.lat, startPoint.lng], { icon: startIcon }).addTo(initialMarkersGroup).bindPopup(popupContent);
    }
    
    document.querySelectorAll('.address-item').forEach((item, index) => {
        const lat = parseFloat(item.getAttribute('data-lat'));
        const lng = parseFloat(item.getAttribute('data-lng'));
        const title = item.getAttribute('data-title');
        
        const numberIcon = L.divIcon({ className: 'number-marker', html: index + 1 });
        
        const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        
        // ОБНОВЛЕНО: Добавлена кнопка "Pašalinti adresą" (Удалить адрес), которая вызывает новую функцию deleteItemByIndex
        const popupContent = `
            <div style="font-family: sans-serif; padding: 2px; min-width: 180px;">
                <b>${index + 1}. Gavėjas:</b> <span style="display:block; margin-bottom:8px; color:#555;">${title}</span>
                <a href="${googleMapsUrl}" target="_blank" style="display: block; text-align: center; background: #4285F4; color: white; text-decoration: none; padding: 6px 10px; border-radius: 4px; font-size: 12px; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 6px;">🗺️ Google Maps Navigacija</a>
                <button onclick="deleteItemByIndex(${index})" style="width: 100%; background: #EA4335; color: white; border: none; padding: 6px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; cursor: pointer;">🗑️ Pašalinti adresą</button>
            </div>
        `;
        
        L.marker([lat, lng], { icon: numberIcon }).addTo(initialMarkersGroup).bindPopup(popupContent);
    });
}

    function clearRouteLine() {
        if (routingControl !== null) { map.removeControl(routingControl); routingControl = null; }
        routeMarkersGroup.clearLayers();
        isRouteCurrentlyBuilt = false; // ИЗМЕНЕНИЕ: Сбрасываем статус при стирании линии
        refreshInitialMarkers();
        saveDataToLocalStorage(); // ИЗМЕНЕНИЕ: Сохраняем факт того, что маршрут сброшен
    }

    // ИЗМЕНЕНИЕ: Добавлен аргумент shouldScroll (по умолчанию true), чтобы страница не прыгала при автозагрузке
   function buildFinalRoute(shouldScroll = true) {
        if (!startPoint) return;
        if (routingControl !== null) { map.removeControl(routingControl); }
        routeMarkersGroup.clearLayers();
        initialMarkersGroup.clearLayers();

        const waypoints = [];
        waypoints.push(L.latLng(startPoint.lat, startPoint.lng));
        
        const startIcon = L.divIcon({ className: 'number-marker start-marker', html: 'S' });
        
        // Кнопка для старта на проложенном маршруте
        const startGpsUrl = `https://www.google.com/maps/dir/?api=1&destination=${startPoint.lat},${startPoint.lng}`;
        const startPopup = `
            <div style="font-family: sans-serif; padding: 2px;">
                <b>Startas:</b> <span style="display:block; margin-bottom:8px; color:#555;">${startPoint.title}</span>
                <a href="${startGpsUrl}" target="_blank" style="display: block; text-align: center; background: #4285F4; color: white; text-decoration: none; padding: 6px 10px; border-radius: 4px; font-size: 12px; font-weight: bold;">🗺️ Google Maps Navigacija</a>
            </div>
        `;
        L.marker([startPoint.lat, startPoint.lng], { icon: startIcon }).addTo(routeMarkersGroup).bindPopup(startPopup);

        document.querySelectorAll('.address-item').forEach((item, index) => {
        const lat = parseFloat(item.getAttribute('data-lat'));
        const lng = parseFloat(item.getAttribute('data-lng'));
        const title = item.getAttribute('data-title');
        waypoints.push(L.latLng(lat, lng));

        const numberIcon = L.divIcon({ className: 'number-marker', html: index + 1 });
        
        const addressGpsUrl = `http://googleusercontent.com/maps.google.com/?q=${lat},${lng}`;
        
        // ОБНОВЛЕНО: Здесь тоже добавлена кнопка удаления по индексу
        const addressPopup = `
            <div style="font-family: sans-serif; padding: 2px; min-width: 180px;">
                <b>${index + 1}. ${title}</b>
                <a href="${addressGpsUrl}" target="_blank" style="display: block; text-align: center; background: #4285F4; color: white; text-decoration: none; padding: 6px 10px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-top:8px; margin-bottom: 6px;">🗺️ Google Maps Navigacija</a>
                <button onclick="deleteItemByIndex(${index})" style="width: 100%; background: #EA4335; color: white; border: none; padding: 6px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; cursor: pointer;">🗑️ Pašalinti adresą</button>
            </div>
        `;
        L.marker([lat, lng], { icon: numberIcon }).addTo(routeMarkersGroup).bindPopup(addressPopup);
    });

        routingControl = L.Routing.control({
            waypoints: waypoints,
            lineOptions: { styles: [{ color: '#10111d', weight: 6, opacity: 0.85 }] },
            createMarker: function() { return null; },
            addWaypoints: false,
            show: false
        }).addTo(map);
        
        isRouteCurrentlyBuilt = true; 
        saveDataToLocalStorage();    

        if (shouldScroll && window.innerWidth <= 768) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    // Пошаговое управление GPS: 1-й клик (Старт), 2-й клик (LIVE), 3-й клик (Выключение)
    // Пошаговое управление GPS (Строго 1 нажатие = 1 действие)
function findMyLocation() {
    if (!navigator.geolocation) {
        alert("Jūsų naršyklė nepalaiko GPS funkcijos.");
        return;
    }

    const gpsButton = document.getElementById('gps-btn');

    switch (gpsState) {
        case 0:
            // === ШАГ 1: ПЕРВОЕ НАЖАТИЕ — Одиночный Старт ===
            gpsButton.innerText = "⏳";

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    const title = `Mano vieta (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                    
                    setStartPoint(title, lat, lng);
                    
                    // Строго переключаем на шаг 1
                    gpsState = 1;
                    gpsButton.innerText = "🎯";
                    gpsButton.style.background = "#4285F4"; // Синяя кнопка
                    gpsButton.style.color = "#ffffff";
                },
                (error) => {
                    resetGpsButton();
                    handleGpsError(error);
                },
                { enableHighAccuracy: true, timeout: 10000 }
            );
            break;

        case 1:
            // === ШАГ 2: ВТОРОЕ НАЖАТИЕ — Включение LIVE трекинга ===
            gpsButton.innerText = "⏳";

            gpsWatchId = navigator.geolocation.watchPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    
                    // Переводим кнопку в режим LIVE (Зеленая)
                    gpsButton.innerText = "🛰️";
                    gpsButton.style.background = "var(--success)"; 
                    gpsButton.style.color = "#ffffff";

                    // Создаем или плавно передвигаем маркер машины
                    if (userLocationMarker === null) {
                        const driverIcon = L.divIcon({
                            className: 'number-marker',
                            html: '🚗',
                            style: 'background: #4285F4; border-color: #ffffff;'
                        });
                        userLocationMarker = L.marker([lat, lng], { icon: driverIcon }).addTo(map)
                            .bindPopup("<b>Jūsų esama pozicija</b>");
                        map.setView([lat, lng], 16); 
                    } else {
                        userLocationMarker.setLatLng([lat, lng]);
                        map.panTo([lat, lng]); // Плавно ведем карту за машиной
                    }
                },
                (error) => {
                    resetGpsButton();
                    handleGpsError(error);
                },
                { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
            );

            // МГНОВЕННО переводим состояние кнопки в Шаг 2, 
            // чтобы следующее нажатие сразу уходило в отключение, 
            // не дожидаясь ответа от спутников
            gpsState = 2; 
            break;

        case 2:
            // === ШАГ 3: ТРЕТЬЕ НАЖАТИЕ — Полное отключение LIVE ===
            resetGpsButton();
            break;
    }
}

// Функция полного сброса (вызывается на 3-й клик или при ошибке)
function resetGpsButton() {
    const gpsButton = document.getElementById('gps-btn');
    
    // Одозначно останавливаем слежение в системе телефона
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    
    // Убираем машинку с карты
    if (userLocationMarker !== null) {
        map.removeLayer(userLocationMarker);
        userLocationMarker = null;
    }
    
    // Сбрасываем статус в ноль и возвращаем белый цвет кнопке
    gpsState = 0;
    gpsButton.innerText = "🎯";
    gpsButton.style.background = "#ffffff";
    gpsButton.style.color = "#10111d";
}

// Функция вывода ошибок GPS
function handleGpsError(error) {
    switch(error.code) {
        case error.PERMISSION_DENIED:
            alert("Klaida: Jūs uždraudėte prieigą prie savo vietovės.");
            break;
        case error.POSITION_UNAVAILABLE:
            alert("Klaida: Nepavyko nustatyti vietos.");
            break;
        case error.TIMEOUT:
            alert("Klaida: Baigėsi vietos nustatymo laikas.");
            break;
        default:
            alert("Įvyko nežinoma GPS klaida.");
    }
}

// Вспомогательная функция для полного сброса кнопки и трекера
function resetGpsButton() {
    const gpsButton = document.getElementById('gps-btn');
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    if (userLocationMarker !== null) {
        map.removeLayer(userLocationMarker);
        userLocationMarker = null;
    }
    gpsState = 0;
    gpsButton.innerText = "🎯";
    gpsButton.style.background = "#ffffff";
    gpsButton.style.color = "#10111d";
}

// Вспомогательная функция для вывода ошибок
function handleGpsError(error) {
    switch(error.code) {
        case error.PERMISSION_DENIED:
            alert("Klaida: Jūs uždraudėte prieigą prie savo vietovės.");
            break;
        case error.POSITION_UNAVAILABLE:
            alert("Klaida: Nepavyko nustatyti vietos.");
            break;
        case error.TIMEOUT:
            alert("Klaida: Baigėsi vietos nustatymo laikas.");
            break;
        default:
            alert("Įvyko nežinoma GPS klaida.");
    }
}
    function deleteStartPoint() {
    if (confirm("Ar tikrai norite pašalinti starto poziciją (A tašką)?")) {
        clearRouteLine();
        startPoint = null;
        document.getElementById('start-point-display').style.display = 'none';
        document.getElementById('start-point-text').innerText = '';
        
        resetGpsButton(); // ОБНОВЛЕНО: Сбрасываем и кнопку GPS в исходное состояние
        
        updateListState();
        refreshInitialMarkers();
        saveDataToLocalStorage();
    }
}

    // Инициализация загрузки сохраненных данных при старте скрипта
    loadDataFromLocalStorage();